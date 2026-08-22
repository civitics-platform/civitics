/**
 * GET /api/phases
 *
 * Reads docs/PHASE_GOALS.md at runtime and returns phase completion data.
 * Replaces the hard-coded PHASES array in DashboardClient.
 */

import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

export const revalidate = 3600; // cache 1 hour at edge

type Phase = {
  name: string;
  label: string;
  pct: number;
  done: boolean;
};

function parsePhases(md: string): Phase[] {
  const phases: Phase[] = [];
  // Three header shapes live in PHASE_GOALS.md:
  //   ## Phase 0 — Scaffold ✓ `Weeks 1–2` `100% complete`
  //   ## Phase 1 — MVP `Weeks 3–10` `~88% complete` ← **current**
  //   ## Phase 2 — Growth `Weeks 11–22` `Planned`
  //
  // FIX-1078: the third shape was not matched. The trailing token was
  // required to be `N% complete`, so Phases 2–5 — every un-started phase,
  // headed `Planned` — parsed to nothing and the route returned 2 of 6.
  // DashboardClient then replaced its six-entry PHASES_FALLBACK with that
  // two-entry list, rendering two bars under a "Phase 1 of 5" header.
  // `Planned` means 0%.
  const headerRe =
    /^## (Phase \d+) — ([^\n`]+?)(?:\s*✓)?\s*`[^`]+`\s*`(?:~?(\d+)% complete|Planned)`/gm;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(md)) !== null) {
    const phaseName = match[1]!.trim();
    const label = match[2]!.trim();
    const pct = match[3] !== undefined ? parseInt(match[3], 10) : 0;
    phases.push({ name: phaseName, label, pct, done: pct === 100 });
  }
  return phases;
}

export async function GET() {
  try {
    // Walk up from app/ to repo root, then to docs/.
    //
    // This resolves on Vercel today (verified 2026-08-22: the deployed route
    // returns Scaffold + MVP parsed from the real file, with no `fallback`
    // flag) because apps/civitics/next.config.mjs deliberately does NOT set
    // `output: "standalone"`, so the whole monorepo — docs/ included — ships
    // into the lambda filesystem. Turning standalone on would break this read
    // and silently drop the route to the fallback below; bundle the file at
    // build time first if that ever happens.
    const mdPath = join(process.cwd(), "../../docs/PHASE_GOALS.md");
    const md = readFileSync(mdPath, "utf8");
    const phases = parsePhases(md);
    if (phases.length === 0) throw new Error("No phases found");
    return NextResponse.json({ phases });
  } catch (e) {
    // Fall back to known-good static data rather than 500. Labels mirror the
    // real PHASE_GOALS.md headers — they had drifted to a set of names
    // ("Foundation", "Civic Core", "Community", "Economy", "Candidates")
    // that appear nowhere in the document (FIX-1078).
    return NextResponse.json({
      phases: [
        { name: "Phase 0", label: "Scaffold",   pct: 100, done: true },
        { name: "Phase 1", label: "MVP",        pct: 88,  done: false },
        { name: "Phase 2", label: "Growth",     pct: 0,   done: false },
        { name: "Phase 3", label: "Social App", pct: 0,   done: false },
        { name: "Phase 4", label: "Blockchain", pct: 0,   done: false },
        { name: "Phase 5", label: "Global",     pct: 0,   done: false },
      ],
      fallback: true,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
