/**
 * GET /api/shipped
 *
 * FIX-1097 — reads docs/done.log at runtime and returns the most recent
 * commits for the dashboard's "Recently shipped" list. The parser lives in
 * src/lib/done-log.ts so it can be unit-tested. (/api/phases, its sibling on
 * the dashboard, reads docs/PHASE_GOALS.md once at build since FIX-1415.)
 *
 * done.log is public repo data — the completion record for a project whose
 * whole pitch is receipts — so nothing here is redacted.
 */

import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { parseDoneLog } from "@/lib/done-log";

export const revalidate = 3600; // cache 1 hour at edge

const LIMIT = 8;

export async function GET() {
  try {
    // App cwd → repo root → docs/. This resolves at runtime
    // on Vercel because apps/civitics/next.config.mjs deliberately does NOT
    // set `output: "standalone"`, so the whole monorepo — docs/ included —
    // ships into the lambda filesystem (established by FIX-1078, and there is
    // no .vercelignore excluding docs/). Turning standalone on would break
    // this read; bundle the file at build time first if that ever happens.
    const logPath = join(process.cwd(), "../../docs/done.log");
    const contents = readFileSync(logPath, "utf8");
    return NextResponse.json({ shipped: parseDoneLog(contents, LIMIT) });
  } catch (e) {
    // No static fallback, deliberately: there is no "known-good" recent-ships
    // list to fall back to, and inventing one would publish a claim about
    // shipped work that nothing backs. An empty array hides the section
    // (DashboardClient), which is the honest degradation.
    return NextResponse.json({
      shipped: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
