/**
 * FIX-1230 — /api/cron/notify-followers takes CRON_SECRET and nothing else.
 *
 * The route used to OR a second key into its gate:
 *
 *   isManualAdmin = request.nextUrl.searchParams.get("manual") === "1";
 *   if (!isVercelCron && !isManualAdmin) return 401;
 *
 * so `?manual=1` alone ran the whole follower fan-out and moved the cursor —
 * no secret, no session, no admin role. Pinned by source, like
 * box-health-route.test.ts: the strict gate the other cron routes inline, and
 * the wrong-but-green shape (rule 105) — a gate that mentions the secret but
 * ORs something else in — refused by name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = readFileSync(
  join(__dirname, "..", "..", "app", "api", "cron", "notify-followers", "route.ts"),
  "utf8",
);

/** The route's code, comments stripped, so prose cannot satisfy or trip an anchor. */
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const STRICT_GATE = /if \(!process\.env\["CRON_SECRET"\] \|\| authHeader !== expected\) \{\s*return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\);/;

test("FIX-1230: the strict CRON_SECRET gate, answering 401", () => {
  assert.match(CODE, /const expected = `Bearer \$\{process\.env\["CRON_SECRET"\] \?\? ""\}`;/);
  assert.match(CODE, STRICT_GATE);
  assert.equal((CODE.match(/status: 401/g) ?? []).length, 1, "one 401 branch");
});

test("FIX-1230: no second key — no ?manual, no query parameter, no OR-ed flag", () => {
  assert.doesNotMatch(CODE, /searchParams\.get\("manual"\)/);
  assert.doesNotMatch(CODE, /isManualAdmin/);
  assert.doesNotMatch(CODE, /isVercelCron/);
  assert.doesNotMatch(CODE, /searchParams/, "the route reads no query parameter at all");
});

test("FIX-1230: nothing but CRON_DISABLED runs before the gate — a bearer-less GET writes nothing", () => {
  const gateAt = CODE.search(STRICT_GATE);
  const disabledAt = CODE.indexOf('process.env["CRON_DISABLED"] === "true"');
  assert.ok(disabledAt > 0 && disabledAt < gateAt, "CRON_DISABLED is checked first");
  const clientAt = CODE.indexOf("createAdminClient({ fetch: noStoreFetch })");
  assert.ok(clientAt > gateAt, "the admin client is built only after the gate");
  const handlerAt = CODE.indexOf("export async function GET(");
  assert.doesNotMatch(CODE.slice(handlerAt, gateAt), /await /, "no awaited read or write before the gate");
});
