/**
 * FIX-1209 — where a receipts run is allowed to write.
 *
 * `receipts-daily.ts` names its output from the nominal day alone, so a LOCAL
 * run and the nightly PROD run resolve to the same
 * `docs/receipts/YYYY-MM-DD.md`. `--local` / `--prod` / `auto` chooses the
 * DATABASE and nothing else, so an operator poking at local Docker silently
 * overwrote the day's committed prod receipt with local numbers — and the diff
 * read as a legitimate update. cc-142 restored 2026-09-22 from HEAD by hand.
 *
 * The rule: a LOCAL run that was not told where to write goes under
 * `local/`, which is gitignored. Being told (`--out`) still wins, because an
 * operator who names a directory means that directory — the same principle
 * `resolveUnderRepoRoot` applies to an absolute path (FIX-1198).
 *
 * `bands.json` deliberately keeps resolving against the CANONICAL directory.
 * It is hand-edited, lives once, and is read by both targets; following the
 * receipt into `local/` would make every job in a redirected run silently read
 * `no-band`, which is a quieter wrong answer than the one being fixed.
 */

import { join } from "node:path";

/** The subdirectory a redirected LOCAL run writes into. Gitignored. */
export const LOCAL_SUBDIR = "local";

/**
 * Does this DSN point at the local Docker Postgres?
 *
 * Needed because `auto` resolves through `.env.local`, so the flag alone does
 * not say which database a run actually reached — and `.env.local` pointing at
 * prod is the documented normal case, not an exotic one. Host-based, since
 * that is the part that distinguishes them: anything not loopback is treated
 * as remote, which fails in the SAFE direction (a misread local run writes the
 * canonical path, exactly as today; a misread prod run cannot be caused by
 * this function).
 */
export function isLocalDsn(dsn: string): boolean {
  return /@(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::|\/|$)/i.test(dsn);
}

/**
 * The directory the receipt itself is written to.
 *
 * `baseDir` is the already-resolved canonical directory (what
 * `resolveUnderRepoRoot` returned), so this stays pure and testable: no
 * filesystem, no cwd, no env.
 */
export function receiptsOutDir(
  baseDir: string,
  opts: { local: boolean; outGiven: boolean },
): string {
  return opts.local && !opts.outGiven ? join(baseDir, LOCAL_SUBDIR) : baseDir;
}
