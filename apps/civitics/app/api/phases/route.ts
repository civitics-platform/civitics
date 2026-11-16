/**
 * GET /api/phases
 *
 * docs/PHASE_GOALS.md → the /dashboard Development Progress card: each phase's
 * percentage computed from its checkboxes, and the current phase's open items
 * (FIX-1415). The parser is src/lib/phase-goals.ts.
 *
 * Read ONCE, at build: `force-static` with no `revalidate`, so `next build`
 * runs this handler and ships its body as a static file. Before FIX-1415 it
 * carried `revalidate = 3600` and re-read the file hourly from the lambda
 * filesystem — a copy of the same deploy-time snapshot, so nothing was gained,
 * and the read depended on `output: "standalone"` staying off. A build-time
 * read needs the file only where the build runs.
 */

import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { phasesPayload } from "@/lib/phase-goals";

export const dynamic = "force-static";

export async function GET() {
  try {
    // `next build` runs in apps/civitics: up to the repo root, then docs/.
    const md = readFileSync(join(process.cwd(), "../../docs/PHASE_GOALS.md"), "utf8");
    return NextResponse.json(phasesPayload(md));
  } catch (e) {
    // No fallback numbers (FIX-1415): the hand-kept list here said Phase 1 was
    // 88 % while the file said 96. An empty `phases` hides the card.
    return NextResponse.json({
      phases: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
