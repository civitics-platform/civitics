/**
 * FIX-1417 — the verdict roll's manifest: members as published, mapped, keyed
 * the walk's way, matched to stored rows. No database.
 *
 * Runs via:  tsx --test src/scripts/fix1417-verdict-roll.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, manifestCounts, membersFromXml, parseTsv, toTsv } from "./fix1417-verdict-roll";

/** The shape of vote_117_1_00059.xml, cut to three members. */
const XML = `<?xml version="1.0" encoding="UTF-8"?><roll_call_vote>
  <congress>117</congress><session>1</session><vote_number>59</vote_number>
  <vote_date>February 13, 2021,  03:39 PM</vote_date>
  <question>Guilty or Not Guilty</question>
  <vote_result>Not Guilty</vote_result>
  <members>
    <member><member_full>Baldwin (D-WI)</member_full><last_name>Baldwin</last_name><first_name>Tammy</first_name><party>D</party><state>WI</state><vote_cast>Guilty</vote_cast><lis_member_id>S354</lis_member_id></member>
    <member><member_full>Barrasso (R-WY)</member_full><last_name>Barrasso</last_name><first_name>John</first_name><party>R</party><state>WY</state><vote_cast>Not Guilty</vote_cast><lis_member_id>S317</lis_member_id></member>
    <member><member_full>Blunt (R-MO)</member_full><last_name>Blunt</last_name><first_name>Roy</first_name><party>R</party><state>MO</state><vote_cast>Not Guilty</vote_cast><lis_member_id>S227</lis_member_id></member>
  </members>
</roll_call_vote>`;

test("members are read as published and mapped: Guilty → yes, Not Guilty → no", () => {
  const m = membersFromXml(XML);
  assert.deepEqual(
    m.map((r) => [r.lis_member_id, r.member_key, r.cast, r.vote]),
    [
      ["S354", "baldwin:WI", "Guilty", "yes"],
      ["S317", "barrasso:WY", "Not Guilty", "no"],
      ["S227", "blunt:MO", "Not Guilty", "no"],
    ],
  );
});

test("each member takes its one stored row by key; no stored row is unmatched; a key two rows share is refused", () => {
  const stored = [
    { vote_id: "v1", official_id: "o1", vote: "not_voting", member_key: "baldwin:WI" },
    { vote_id: "v2", official_id: "o2", vote: "not_voting", member_key: "barrasso:WY" },
    { vote_id: "v3", official_id: "o3", vote: "not_voting", member_key: "barrasso:WY" },
  ];
  const manifest = buildManifest(membersFromXml(XML), stored);
  assert.deepEqual(manifest.map((r) => r.vote_id), ["v1", "", ""]);
  assert.deepEqual(manifestCounts(manifest), { yes: 1, no: 0, not_voting: 0, unmatched: 2 });
});

test("the TSV round-trips, and a wrong header is refused", () => {
  const manifest = buildManifest(membersFromXml(XML), [
    { vote_id: "v1", official_id: "o1", vote: "not_voting", member_key: "baldwin:WI" },
  ]);
  assert.deepEqual(parseTsv(toTsv(manifest)), manifest);
  assert.deepEqual(parseTsv(toTsv(manifest).replace(/\n/g, "\r\n")), manifest);
  assert.throws(() => parseTsv("a\tb\n1\t2\n"), /manifest header/);
});
