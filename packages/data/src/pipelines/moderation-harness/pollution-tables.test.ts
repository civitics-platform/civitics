/**
 * FIX-825 — the harness's zero-pollution watch covers the two user tables its
 * fixtures write (auth.users, public.users), schema-qualified.
 *
 * Runs via:  tsx --test src/pipelines/moderation-harness/pollution-tables.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { POLLUTION_TABLES, pollutionCountSql, pollutionLabel } from "./pollution-tables";

test("FIX-825: the watch holds the eight content tables plus auth.users and public.users", () => {
  const labels = POLLUTION_TABLES.map(pollutionLabel);
  assert.equal(labels.length, 10);
  assert.equal(new Set(labels).size, 10, "no table watched twice");
  assert.ok(labels.includes("auth.users"));
  assert.ok(labels.includes("public.users"));
  for (const t of [
    "entity_comments", "content_flags", "comment_ratings", "entity_positions",
    "position_events", "evidence_cards", "citations", "investigations",
  ]) {
    assert.ok(labels.includes(`public.${t}`), `public.${t} still watched`);
  }
});

test("FIX-825: every count is schema-qualified with quoted identifiers", () => {
  assert.equal(pollutionCountSql({ schema: "auth", table: "users" }), 'SELECT count(*)::bigint AS n FROM "auth"."users"');
  for (const t of POLLUTION_TABLES) assert.match(pollutionCountSql(t), /FROM "(public|auth)"\."[a-z_]+"$/);
});

test("FIX-825: every table the fixtures INSERT into is watched", () => {
  const src = fs.readFileSync(path.join(__dirname, "fixtures.ts"), "utf8");
  const written = new Set([...src.matchAll(/INSERT INTO ((?:public|auth)\.[a-z_]+)/g)].map((m) => m[1]!));
  const watched = new Set(POLLUTION_TABLES.map(pollutionLabel));
  const unwatched = [...written].filter((t) => !watched.has(t));
  assert.deepEqual(unwatched, [], `fixture-written tables missing from the watch: ${unwatched.join(", ")}`);
});
