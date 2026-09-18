/**
 * FIX-1173 — the kill-switch parse boundary.
 *
 * WHY THIS FILE EXISTS AT ALL. The `cron` switch was removed from
 * `KillSwitchName`, but prod's `pipeline_state.kill_switches` JSONB row still
 * carries a `cron` key and `kill_switch_events` still carries its history. The
 * data was deliberately not migrated: rewriting a JSONB blob to satisfy a
 * TypeScript union is a schema change in service of a type, and the history
 * rows would survive either way.
 *
 * So the union has to be ENFORCED where the JSON enters the program. Two places
 * used to cast instead of check — `loadMap`'s `value as KillSwitchesMap` and
 * `auto-trip-evaluator`'s `Object.entries(switches)` with the key cast to
 * `KillSwitchName` — and a cast over data a human edited months ago is a
 * statement of hope. The evaluator's consequence today is small (one
 * `skip_no_metrics` decision naming a switch that no longer exists); the
 * consequence tomorrow is whatever the next reader assumes about those keys.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { filterKillSwitchesMap, isKillSwitchName } from "./kill-switches";

/** Prod's row, verbatim shape, as of the 2026-09-18 read. */
const PROD_ROW = {
  cron: { enabled: true, metrics: [], auto_trip_threshold_pct: null },
  ai_tagger: { enabled: true, metrics: ["anthropic.monthly_spend_usd"], auto_trip_threshold_pct: 90 },
  ai_narrative: { enabled: true, metrics: ["anthropic.monthly_spend_usd"], auto_trip_threshold_pct: 90 },
  ai_summaries: { enabled: true, metrics: ["anthropic.monthly_spend_usd"], auto_trip_threshold_pct: 90 },
  mapbox_geocode: { enabled: true, metrics: [], auto_trip_threshold_pct: null },
  cf_auto_mitigation: { enabled: true, metrics: [], auto_trip_threshold_pct: null },
  connection_graph_live: {
    enabled: true,
    metrics: ["supabase.api_requests_7d", "supabase.disk_used_bytes"],
    auto_trip_threshold_pct: 95,
  },
};

test("FIX-1173: prod's live row parses WITHOUT the retired cron key, and without throwing", () => {
  const m = filterKillSwitchesMap(PROD_ROW);
  assert.ok(m);
  assert.ok(!("cron" in m), "the retired switch must not reach typed code");
  // Everything else survives untouched — the filter drops keys, it does not
  // rebuild values.
  assert.deepEqual(Object.keys(m).sort(), [
    "ai_narrative",
    "ai_summaries",
    "ai_tagger",
    "cf_auto_mitigation",
    "connection_graph_live",
    "mapbox_geocode",
  ]);
  assert.equal(m.connection_graph_live.auto_trip_threshold_pct, 95);
  assert.deepEqual(m.ai_tagger.metrics, ["anthropic.monthly_spend_usd"]);
});

test("an unknown key is DROPPED, not thrown on", () => {
  // Filtering rather than throwing is the whole design: an unrecognised key is
  // not a reason to fail every kill-switch read on the platform, and
  // isKillSwitchEnabled already falls through to "on" for a missing key — so a
  // dropped key behaves exactly like one that was never written.
  const m = filterKillSwitchesMap({
    ai_tagger: { enabled: false, metrics: [], auto_trip_threshold_pct: null },
    something_nobody_has_shipped_yet: { enabled: false },
  });
  assert.ok(m);
  assert.deepEqual(Object.keys(m), ["ai_tagger"]);
  assert.equal(m.ai_tagger.enabled, false);
});

test("null and undefined stay null — a read miss is not an empty map", () => {
  // loadMap returns null on a miss and isKillSwitchEnabled falls through to
  // "on". An empty map would mean the same thing today and would stop meaning
  // it the moment a caller iterates the map instead of indexing it.
  assert.equal(filterKillSwitchesMap(null), null);
  assert.equal(filterKillSwitchesMap(undefined), null);
});

test("a row with ONLY retired keys parses to an empty map, not null", () => {
  // The distinction matters: null means "could not read", {} means "read it and
  // there is nothing live in it". Collapsing them would report a successful
  // read of a stale row as a DB failure.
  const m = filterKillSwitchesMap({ cron: { enabled: false } });
  assert.deepEqual(m, {});
});

test("isKillSwitchName recognises every live switch and rejects the retired one", () => {
  for (const n of [
    "ai_summaries",
    "ai_narrative",
    "ai_tagger",
    "connection_graph_live",
    "mapbox_geocode",
    "cf_auto_mitigation",
  ]) {
    assert.ok(isKillSwitchName(n), `${n} must be a live switch`);
  }
  assert.ok(!isKillSwitchName("cron"), "cron was removed by FIX-1173");
  assert.ok(!isKillSwitchName(""), "the empty string is not a switch");
  assert.ok(!isKillSwitchName(undefined));
  assert.ok(!isKillSwitchName(42));
});

test("the guard is not fooled by a prototype key", () => {
  // `hasOwnProperty.call` rather than `name in ENV_RULES`: "toString" is `in`
  // every object, and a switch named after an Object.prototype member reaching
  // typed code would index ENV_RULES to a function.
  assert.ok(!isKillSwitchName("toString"));
  assert.ok(!isKillSwitchName("constructor"));
  assert.deepEqual(filterKillSwitchesMap({ toString: { enabled: false } }), {});
});
