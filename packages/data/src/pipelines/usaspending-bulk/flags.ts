/**
 * FIX-1274 / FIX-1291 — the USASpending dials, parsed ONCE for both entries.
 *
 * The standalone entry (`src/scripts/usaspending-bulk.ts`, the
 * `data:usaspending-bulk*` scripts) and
 * the CI entry (`pipelines/index.ts usaspending`, `data:usaspending-bulk:ci`)
 * read the same flags through this one function, so a dial cannot mean one
 * thing on a supervised run and another in a workflow.
 *
 *   --category contracts|assistance|both   default both
 *   --force                                ignore the baseline: a Full re-run
 *   --max-parts N                          parts this INVOCATION may process
 *   --max-minutes N                        wall dial; checked at part boundaries
 *                                          and every 100k rows. A soft stop:
 *                                          the current flush finishes, nothing
 *                                          mid-part is checkpointed
 *   --gate-wait-s N                        box_backoff_gate wait, default 1800.
 *                                          0 = gate OFF — local only
 *   --breather-s N                         sleep between parts, default 60
 *   --keep-archive / --no-keep-archive     keep the downloaded zip across
 *                                          invocations (standalone default ON,
 *                                          CI default OFF)
 *   --local-archive <zip>                  dev only: process this zip as the
 *                                          delta, skip the listing
 *   --allow-prod                           createAdminClient's FIX-158 guard
 *
 * Both `--flag value` and `--flag=value` are accepted. An unknown flag is an
 * error, not a no-op: a typo'd `--categroy` silently running BOTH categories
 * against prod is the failure this refuses.
 *
 * Why the two waits are capped at 3000 s: the nightly's reaper reaps a
 * `running` row whose heartbeat is older than 60 min (FIX-1291), and neither
 * the gate's poll nor the breather stamps one. A wait past the reaper's
 * threshold would get a live run reaped.
 */

import type { BulkCategory } from "./index";

export type CategoryChoice = BulkCategory | "both";
export type UsaSpendingEntry = "standalone" | "ci";

export interface UsaSpendingFlags {
  category:     CategoryChoice;
  /** The categories to run, in order. */
  categories:   BulkCategory[];
  force:        boolean;
  maxParts:     number | null;
  maxMinutes:   number | null;
  /** 0 = the box gate is off (refused with --allow-prod). */
  gateWaitS:    number;
  breatherS:    number;
  keepArchive:  boolean;
  localArchive: string | null;
  allowProd:    boolean;
}

export const DEFAULT_GATE_WAIT_S = 1800;
export const DEFAULT_BREATHER_S  = 60;
/** Under the reaper's 60-minute staleness rule, with ten minutes to spare. */
export const MAX_WAIT_S          = 3000;

export class UsaSpendingFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsaSpendingFlagError";
  }
}

const VALUE_FLAGS = new Set([
  "--category", "--max-parts", "--max-minutes", "--gate-wait-s", "--breather-s", "--local-archive",
]);
const BOOLEAN_FLAGS = new Set(["--force", "--keep-archive", "--no-keep-archive", "--allow-prod"]);

function toNumber(flag: string, raw: string, opts: { integer: boolean; min: number; max?: number }): number {
  const n = Number(raw);
  const bad =
    raw.trim() === "" ||
    !Number.isFinite(n) ||
    (opts.integer && !Number.isInteger(n)) ||
    n < opts.min ||
    (opts.max !== undefined && n > opts.max);
  if (bad) {
    const range = opts.max !== undefined ? `${opts.min}..${opts.max}` : `>= ${opts.min}`;
    throw new UsaSpendingFlagError(
      `${flag} ${JSON.stringify(raw)}: expected ${opts.integer ? "an integer" : "a number"} ${range}`,
    );
  }
  return n;
}

export function parseUsaSpendingFlags(
  argv:  readonly string[],
  entry: UsaSpendingEntry,
): UsaSpendingFlags {
  const values = new Map<string, string>();
  const bools  = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;                 // pnpm's separator, passed through
    const eq   = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;

    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 && arg.startsWith("--") ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq < 0 && value.startsWith("--"))) {
        throw new UsaSpendingFlagError(`${name} needs a value`);
      }
      values.set(name, value);
    } else if (BOOLEAN_FLAGS.has(arg)) {
      bools.add(arg);
    } else {
      throw new UsaSpendingFlagError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }

  const categoryRaw = (values.get("--category") ?? "both").toLowerCase();
  if (categoryRaw !== "contracts" && categoryRaw !== "assistance" && categoryRaw !== "both") {
    throw new UsaSpendingFlagError(
      `--category ${JSON.stringify(categoryRaw)}: expected contracts, assistance or both`,
    );
  }
  const category = categoryRaw as CategoryChoice;
  const categories: BulkCategory[] =
    category === "both" ? ["contracts", "assistance"] : [category];

  const maxPartsRaw   = values.get("--max-parts");
  const maxMinutesRaw = values.get("--max-minutes");
  const gateRaw       = values.get("--gate-wait-s");
  const breatherRaw   = values.get("--breather-s");

  if (bools.has("--keep-archive") && bools.has("--no-keep-archive")) {
    throw new UsaSpendingFlagError("--keep-archive and --no-keep-archive are mutually exclusive");
  }

  const flags: UsaSpendingFlags = {
    category,
    categories,
    force:        bools.has("--force"),
    maxParts:     maxPartsRaw === undefined ? null : toNumber("--max-parts", maxPartsRaw, { integer: true, min: 1 }),
    maxMinutes:   maxMinutesRaw === undefined ? null : toNumber("--max-minutes", maxMinutesRaw, { integer: false, min: 0.01 }),
    gateWaitS:    gateRaw === undefined
      ? DEFAULT_GATE_WAIT_S
      : toNumber("--gate-wait-s", gateRaw, { integer: true, min: 0, max: MAX_WAIT_S }),
    breatherS:    breatherRaw === undefined
      ? DEFAULT_BREATHER_S
      : toNumber("--breather-s", breatherRaw, { integer: false, min: 0, max: MAX_WAIT_S }),
    keepArchive:  bools.has("--keep-archive")
      ? true
      : bools.has("--no-keep-archive")
        ? false
        : entry === "standalone",
    localArchive: values.get("--local-archive") ?? null,
    allowProd:    bools.has("--allow-prod"),
  };

  // FIX-1291 — the two levers that exist for the clone rehearsal are refused
  // wherever prod is in play. --allow-prod is on both prod scripts (:ci, :prod).
  if (flags.allowProd && flags.gateWaitS === 0) {
    throw new UsaSpendingFlagError(
      "--gate-wait-s 0 turns the box gate OFF, which is local-only — refused with --allow-prod (FIX-1291)",
    );
  }
  if (flags.allowProd && flags.localArchive !== null) {
    throw new UsaSpendingFlagError("--local-archive is a dev lever — refused with --allow-prod (FIX-1291)");
  }
  if (flags.localArchive !== null && categories.length !== 1) {
    throw new UsaSpendingFlagError(
      "--local-archive is one category's zip — pass --category contracts or --category assistance",
    );
  }
  if (flags.localArchive !== null && flags.force) {
    throw new UsaSpendingFlagError("--local-archive is processed as a delta — --force (a Full re-run) contradicts it");
  }

  return flags;
}
