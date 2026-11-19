/**
 * FIX-1433 — the graph's vote tier, read off the edge.
 *
 * /api/graph/connections' "procedural votes" toggle is the vote edge's
 * advance tier: the FIX-1409 rule writes a final edge at strength 0.500 and an
 * advance edge (cloture, a motion to proceed or to discharge) at 0.250, and
 * voteEdgeTier() splits them at VOTE_TIER_FINAL_MIN_STRENGTH. Pinned here:
 * the helper's verdicts, the migration's two literals against the threshold
 * (read from the migration's text), the route's source (no prefix list, no
 * `votes` read — FIX-125's filter is gone) and packages/graph's single-edge
 * label. The label helper is tested in this suite because packages/graph's
 * own *.test.ts files have no runner in CI; connections.ts has no d3 import,
 * so it loads under tsx by relative path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { voteEdgeTier, VOTE_TIER_FINAL_MIN_STRENGTH } from "./graph-vote-tier";
import { connectionEdgeLabel } from "../../../../packages/graph/src/connections";

const REPO = join(__dirname, "..", "..", "..", "..");
const ROUTE = readFileSync(join(__dirname, "..", "..", "app", "api", "graph", "connections", "route.ts"), "utf8");
const MIGRATION = readFileSync(
  join(REPO, "supabase", "migrations", "20261117000000_fix1409_vote_edge_question_rule.sql"),
  "utf8",
);

const edge = (connection_type: string, strength: number | string, evidence_source = "votes") => ({
  connection_type,
  evidence_source,
  strength,
});

test("FIX-1433 D1: voteEdgeTier reads the tier off the row", () => {
  assert.equal(voteEdgeTier(edge("vote_yes", 0.5)), "final");
  assert.equal(voteEdgeTier(edge("vote_no", 0.5)), "final");
  assert.equal(voteEdgeTier(edge("vote_yes", 0.25)), "advance");
  assert.equal(voteEdgeTier(edge("vote_no", 0.25)), "advance");
  // PostgREST may hand numeric back as a string.
  assert.equal(voteEdgeTier(edge("vote_no", "0.250")), "advance");
  assert.equal(voteEdgeTier(edge("vote_yes", "0.500")), "final");
  // Not a vote: no tier at all.
  assert.equal(voteEdgeTier(edge("donation", 0.25, "financial_relationships")), null);
  assert.equal(voteEdgeTier(edge("donation", 0.25)), null);
  // A vote edge from another evidence_source is final whatever its strength.
  assert.equal(voteEdgeTier(edge("vote_yes", 0.25, "investigation")), "final");
  // Only vote_yes / vote_no are tiered by the FIX-1409 rule.
  assert.equal(voteEdgeTier(edge("vote_abstain", 0.25)), "final");
  assert.equal(voteEdgeTier(edge("nomination_vote_yes", 0.25)), "final");
});

test("FIX-1433 D5: the migration's vote-edge strengths are 0.500 and 0.250 and straddle the threshold", () => {
  const pairs = [...MIGRATION.matchAll(/WHEN 'final' THEN (\d+\.\d+)\s+ELSE (\d+\.\d+)/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 2, "the vote-edge CASE not found in the migration");
  for (const [final, advance] of pairs) {
    assert.equal(final, "0.500");
    assert.equal(advance, "0.250");
  }
  assert.ok(0.5 >= VOTE_TIER_FINAL_MIN_STRENGTH && 0.25 < VOTE_TIER_FINAL_MIN_STRENGTH);
  assert.equal(voteEdgeTier(edge("vote_yes", "0.500")), "final");
  assert.equal(voteEdgeTier(edge("vote_yes", "0.250")), "advance");
});

test("FIX-1433 D2: the route keeps no prefix list and reads no votes", () => {
  assert.doesNotMatch(ROUTE, /PROCEDURAL_PREFIXES/);
  assert.doesNotMatch(ROUTE, /filterProceduralConnections/);
  assert.doesNotMatch(ROUTE, /\.from\(\s*["']votes["']\s*\)/);
  // The capped vote read takes the tier in its WHERE.
  assert.match(ROUTE, /\.gte\("strength", VOTE_TIER_FINAL_MIN_STRENGTH\)/);
  assert.match(ROUTE, /voteTier: "advance"/);
});

test("FIX-1433 D3: an advance edge says what it is", () => {
  assert.equal(connectionEdgeLabel("vote_yes", "advance"), "Voted Yes to advance");
  assert.equal(connectionEdgeLabel("vote_no", "advance"), "Voted No to advance");
  assert.equal(connectionEdgeLabel("vote_yes"), "Voted Yes");
  assert.equal(connectionEdgeLabel("vote_no"), "Voted No");
  // Only the two tiered types take the suffix.
  assert.equal(connectionEdgeLabel("donation", "advance"), "Donations");
  assert.equal(connectionEdgeLabel("vote_abstain", "advance"), "Abstained");
  // An unregistered type falls back to its spaced name, as before.
  assert.equal(connectionEdgeLabel("business_partner"), "business partner");
});
