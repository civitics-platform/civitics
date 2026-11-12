// The two telemetry beacons' visitor rules (cc-273): which requests are the
// Chrome 133–142 fleet (FIX-1404), and which country a page view came from
// (FIX-1405). Used by app/api/track-view/route.ts and
// app/api/platform/web-vitals/route.ts. Pure: no next/* import, so it runs
// under tsx --test.
//
// THE FLEET (FIX-1403, docs/audits/2026-11-09-upstash-spend-census.md §12). Ten
// exact Windows Chrome strings, 13–24 releases stale against the zone's real
// Chrome (155–157): a residential-proxy browser farm that runs JS, loads about
// one deep-link page per IP and fires its beacons. Since 11-01 it is ~96 % of
// web_vitals_samples (29,412 of 30,605 rows) and ~95.8 % of page_views.
// next/server's userAgent().isBot does not know these strings, so before this
// every fleet view was written as a human Chrome view.
//
// The match is EXACT equality after trim(), never a regex over the family: a
// UA with any extra token (Edge's `Edg/`, Opera's `OPR/`), another OS, or
// Chrome 132 / 143 / current is not the fleet. To add or retire a string, edit
// the list below and its test; docs/CLOUDFLARE.md §Origin auth, "The beacon
// routes", says how to reverse the flag on past rows.
//
// THE COST OF A FALSE POSITIVE. A real Windows user still on one of these ten
// releases loses only telemetry: their page_views row is labelled
// `chrome-133-142` (still written, so still countable) and their Web Vitals
// samples are not stored. No page, API or limiter behaviour changes for them.

/** The ten user agents audit §12 classifies as the fleet (`userAgent_in`). */
export const CHROME_FLEET_UAS: ReadonlySet<string> = Object.freeze(
  new Set([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  ]),
);

/** The `page_views.bot_name` a fleet view is written under; `get_pv_bots` groups by it. */
export const CHROME_FLEET_BOT_NAME = "chrome-133-142";

/** True when the user agent is exactly one of the fleet's ten strings. */
export function isChromeFleetUa(ua: string | null | undefined): boolean {
  if (!ua) return false;
  return CHROME_FLEET_UAS.has(ua.trim());
}

const COUNTRY_RE = /^[A-Z]{2}$/;

/**
 * The visitor's country for `page_views.country_code` (FIX-1405).
 *
 * `x-vercel-ip-country` geolocates the TCP peer, and behind Cloudflare that is
 * the Cloudflare edge (the same root cause as FIX-1401's limiter key): audit §12
 * read the DB's top 5 as US · SG · BR · FR · HK while the fleet's visitors were
 * BR · IN · VN · US · MX. `cf-ipcountry` is the visitor as Cloudflare saw them,
 * ISO alpha-2, with `XX` for unknown and `T1` for Tor.
 *
 * - `cf-ipcountry` PRESENT → it, upper-cased, when it is two letters and not
 *   `XX`; otherwise null. Never `x-vercel-ip-country` on a request that crossed
 *   Cloudflare, because that value is the edge's.
 * - `cf-ipcountry` ABSENT (the alias, a preview, local) → `x-vercel-ip-country`,
 *   as before.
 *
 * Trust: under ORIGIN_AUTH_MODE=enforce every production request the route
 * sees crossed Cloudflare, which sets the header. Under `report` / `off` a
 * client could send it itself; the stake is a country label on an internal
 * dashboard.
 */
export function visitorCountry(headers: { get(name: string): string | null }): string | null {
  const cf = headers.get("cf-ipcountry");
  if (cf !== null) {
    const code = cf.trim().toUpperCase();
    return COUNTRY_RE.test(code) && code !== "XX" ? code : null;
  }
  return headers.get("x-vercel-ip-country") ?? null;
}
