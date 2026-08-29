/**
 * FIX-1119 — the /meetings surface is gated OFF by default.
 *
 * Craig's call (2026-08-24): the surface is unfinished and should not be
 * reachable, but none of its code should be deleted — it is a real feature
 * waiting on content, not a mistake.
 *
 * DEFAULT-OFF WITH NO NEW ENV ANYWHERE. The test is `=== "true"`, not
 * `!== "false"`, so an unset variable disables the surface. Nothing has to be
 * added to .env.local, .env.example or Vercel for the intended (hidden) state —
 * which is the FIX-311 lesson applied in the opposite direction: that split
 * introduced env-level HARD KILLS whose default was on, so absence had to mean
 * "enabled"; here absence must mean "hidden".
 *
 * TO REVIVE THE SURFACE, in this order:
 *   1. Set MEETINGS_ENABLED=true — in .env.local for local, and in the Vercel
 *      project env (all environments) for prod. Add the key name to .env.example.
 *   2. Build a /meetings INDEX route. There has never been one. The flag alone
 *      un-hides the detail pages and the inbound card/search links; a bare
 *      /meetings still 404s until an index page exists, which is why the NavBar
 *      entry pointing at it was removed rather than flag-gated.
 *   3. Restore the NavBar item and the sitemap entry (both are commented at
 *      their removal sites with a pointer back here).
 *
 * SERVER-ONLY BY DESIGN. This reads a non-NEXT_PUBLIC variable, so if the module
 * is ever pulled into a client bundle the value is `undefined` and the surface
 * reads as disabled. Failing toward hidden is the correct direction for a gate
 * whose whole purpose is to hide something.
 */
export function meetingsEnabled(): boolean {
  return process.env["MEETINGS_ENABLED"] === "true";
}
