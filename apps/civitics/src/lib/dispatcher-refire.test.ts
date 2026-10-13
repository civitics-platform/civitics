/**
 * FIX-1308 — the box-health route's dispatcher re-fire.
 *
 *   - shouldRefireDispatcher(): the four branches (no rows, table absent, fresh,
 *     stale), with the real 360 s boundary — 360 s is NOT stale, 361 s is (rule
 *     213: test the boundary the code ships, not a convenient one).
 *   - the route, anchored by source: dispatch_one_unit is called exactly once,
 *     only under shouldRefireDispatcher's verdict, with p_source 'vercel', raced
 *     by withDbTimeout; the route never reads the box or the pause dial itself
 *     (the function does both).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCHER_STALE_SECONDS, isTableAbsent, shouldRefireDispatcher } from "./dispatcher-refire";

const NOW = new Date("2026-10-15T23:30:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

test("FIX-1308: the stale line is 360 s — three missed odd-minute ticks", () => {
  assert.equal(DISPATCHER_STALE_SECONDS, 360);
});

test("FIX-1308: no dispatch_log rows → no re-fire, 'not landed'", () => {
  const v = shouldRefireDispatcher({ read: { lastTickAt: null }, now: NOW });
  assert.equal(v.refire, false);
  assert.equal(v.notLanded, true);
  assert.match(v.reason, /no dispatch_log rows — not landed/);
});

test("FIX-1308: the table absent (route deployed before the Pro push) → no re-fire, no error", () => {
  for (const error of [
    { code: "42P01", message: 'relation "public.dispatch_log" does not exist' },
    { code: "PGRST205", message: "Could not find the table 'public.dispatch_log' in the schema cache" },
  ]) {
    assert.equal(isTableAbsent(error), true, error.code);
    const v = shouldRefireDispatcher({ read: { lastTickAt: null, error }, now: NOW });
    assert.equal(v.refire, false);
    assert.equal(v.notLanded, true, error.code);
  }
  // Any OTHER read failure is not "not landed" — it is reported, and still does not re-fire.
  const other = shouldRefireDispatcher({
    read: { lastTickAt: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
    now: NOW,
  });
  assert.equal(other.refire, false);
  assert.equal(other.notLanded, false);
  assert.match(other.reason, /read failed/);
});

test("FIX-1308: a fresh tick (≤ 360 s, the boundary itself included) → no re-fire", () => {
  for (const s of [0, 119, 240, 359, 360]) {
    const v = shouldRefireDispatcher({ read: { lastTickAt: ago(s) }, now: NOW });
    assert.equal(v.refire, false, `${s} s`);
    assert.equal(v.ageSeconds, s);
  }
  // 360.9 s floors to 360: still not stale.
  const frac = shouldRefireDispatcher({
    read: { lastTickAt: new Date(NOW.getTime() - 360_900).toISOString() },
    now: NOW,
  });
  assert.equal(frac.refire, false);
});

test("FIX-1308: a stale tick (> 360 s) → re-fire", () => {
  for (const s of [361, 600, 86_400]) {
    const v = shouldRefireDispatcher({ read: { lastTickAt: ago(s) }, now: NOW });
    assert.equal(v.refire, true, `${s} s`);
    assert.equal(v.ageSeconds, s);
    assert.match(v.reason, /re-firing/);
  }
});

// ── the route, by source ─────────────────────────────────────────────────────

const ROUTE = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "box-health", "route.ts"), "utf8");
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("FIX-1308: the route calls dispatch_one_unit exactly once, with p_source 'vercel', raced", () => {
  const calls = CODE.match(/db\.rpc\("dispatch_one_unit"/g) ?? [];
  assert.equal(calls.length, 1, "exactly one dispatch_one_unit call site");
  assert.match(CODE, /db\.rpc\("dispatch_one_unit", \{ p_source: "vercel" \}\)/);
  const at = CODE.indexOf('db.rpc("dispatch_one_unit"');
  assert.ok(CODE.lastIndexOf("withDbTimeout(", at) > CODE.lastIndexOf(";", at - 1) - 200, "inside a withDbTimeout race");
});

test("FIX-1308: the re-fire happens only under shouldRefireDispatcher's verdict", () => {
  const verdictAt = CODE.indexOf("shouldRefireDispatcher(");
  const callAt = CODE.indexOf('db.rpc("dispatch_one_unit"');
  assert.ok(verdictAt > 0 && callAt > verdictAt, "the verdict is computed before the call");
  // The call sits inside the `if (<verdict>.refire)` block.
  const guard = /if \((\w+)\.refire\) \{/.exec(CODE.slice(verdictAt, callAt));
  assert.ok(guard, "dispatch_one_unit is guarded by `if (<verdict>.refire) {`");
});

test("FIX-1308: the route reads dispatch_log's newest ticked_at, raced, and never reads the box or the pause dial", () => {
  assert.match(CODE, /\.from\("dispatch_log"\)\s*\.select\("ticked_at"\)\s*\.order\("ticked_at", \{ ascending: false \}\)\s*\.limit\(1\)/);
  assert.match(CODE, /"box-health:dispatch"/);
  assert.doesNotMatch(CODE, /box_is_saturated|platform_dials|pause/, "the function reads the box and the pause dial, not the route");
});
