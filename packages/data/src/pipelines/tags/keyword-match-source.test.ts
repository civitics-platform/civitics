/**
 * FIX-1280 — the keyword pass reads an O/U/V/W committee's connected
 * organisation, never its own cause words; the `lobby` list (organisation
 * names) still reads the committee's own name.
 *
 * Every fixture is a real prod committee (cc-196 read 3, 2026-10-05). The
 * wrong-but-green twins: a super PAC with a cause word and no sponsor gets NO
 * row; a corporate PAC still matches its own name; a super PAC whose sponsor is
 * a union still gets labor, from the sponsor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  keywordMatchSource,
  matchIndustryKeywords,
  SPONSOR_MATCHED_CMTE_TYPES,
  SPONSOR_NAME_INDUSTRIES,
  INDUSTRY_KEYWORDS,
  type KeywordEntityInput,
} from "./rules";
import { cmteTypeToEntityType } from "../fec-bulk/writer";

function cmte(display_name: string, cmte_type: string | null, connected_org: string | null): KeywordEntityInput {
  return { display_name, cmte_type, connected_org };
}

const industries = (e: KeywordEntityInput) => matchIndustryKeywords(e).map((m) => m.industry).sort();

test("a super PAC named for a cause, with no sponsor, gets no keyword row", () => {
  // The old pass read the display name: defense, labor, defense+labor, health, tech.
  assert.deepEqual(matchIndustryKeywords(cmte("COMMON DEFENSE ACTION FUND", "V", "NONE")), []);
  assert.deepEqual(matchIndustryKeywords(cmte("WORKERS VOTE", "O", null)), []);
  assert.deepEqual(matchIndustryKeywords(cmte("POLICE OFFICERS DEFENSE ALLIANCE LLC", "O", "")), []);
  assert.deepEqual(matchIndustryKeywords(cmte("COMMITTEE TO PROTECT HEALTH CARE PAC", "V", null)), []);
  assert.deepEqual(matchIndustryKeywords(cmte("TECH FOR CAMPAIGNS", "V", "NONE")), []);
  assert.equal(keywordMatchSource(cmte("COMMON DEFENSE ACTION FUND", "V", "NONE")), null);
});

test("FEC's placeholders for no sponsor all read as none", () => {
  for (const org of [null, "", "   ", "NONE", "none", " None ", "N/A", "NA"]) {
    assert.equal(keywordMatchSource(cmte("DEMOCRACY DEFENSE ACTION", "V", org)), null, `connected org ${JSON.stringify(org)}`);
  }
});

test("a super PAC whose sponsor is a union gets labor, matched on the sponsor", () => {
  assert.deepEqual(
    matchIndustryKeywords(cmte("LABORERS' INTERNATIONAL UNION OF NORTH AMERICA POLITICAL FUND", "O", "LABORERS' INTERNATIONAL UNION OF NORTH AMERICA")),
    [{ industry: "labor", matched_on: "connected_org" }],
  );
  // The name carries no keyword at all; the sponsor does.
  assert.deepEqual(
    matchIndustryKeywords(cmte("USW WORKS", "O", "UNITED STEELWORKERS")),
    [{ industry: "labor", matched_on: "connected_org" }],
  );
  assert.deepEqual(
    matchIndustryKeywords(cmte("NATIONAL ASSOCIATION OF REALTORS CONGRESSIONAL FUND", "O", "NATIONAL ASSOCIATION OF REALTORS")),
    [{ industry: "real_estate", matched_on: "connected_org" }],
  );
});

test("a corporate or trade PAC (N/Q) matches its own name exactly as before", () => {
  assert.deepEqual(
    matchIndustryKeywords(cmte("LOCKHEED MARTIN CORPORATION EMPLOYEES' POLITICAL ACTION COMMITTEE", "Q", "LOCKHEED MARTIN CORPORATION")),
    [{ industry: "defense", matched_on: "display_name" }],
  );
  // RTX: no keyword in its name, and the sponsor is not consulted for a Q.
  assert.deepEqual(matchIndustryKeywords(cmte("EMPLOYEES OF RTX CORPORATION POLITICAL ACTION COMMITTEE", "Q", "RTX CORPORATION")), []);
  assert.deepEqual(keywordMatchSource(cmte("AMERICAN DENTAL ASSOCIATION PAC", "N", "NONE")), {
    text: "american dental association pac",
    source: "display_name",
  });
});

test("an entity with no committee type (a corporation, a non-FEC donor) matches its display name", () => {
  assert.deepEqual(matchIndustryKeywords(cmte("EXXON MOBIL CORPORATION", null, null)), [
    { industry: "oil_gas", matched_on: "display_name" },
  ]);
  assert.deepEqual(keywordMatchSource(cmte("Some Union Local", null, "UNITED STEELWORKERS")), {
    text: "some union local",
    source: "display_name",
  });
});

test("the lobby list still reads a super PAC's own name (Craig 2026-10-05)", () => {
  assert.deepEqual(matchIndustryKeywords(cmte("CLUB FOR GROWTH ACTION", "O", "NONE")), [
    { industry: "lobby", matched_on: "display_name" },
  ]);
  assert.deepEqual(matchIndustryKeywords(cmte("NRA VICTORY FUND, INC.", "O", null)), [
    { industry: "lobby", matched_on: "display_name" },
  ]);
  assert.deepEqual(matchIndustryKeywords(cmte("GUN OWNERS ACTION FUND", "O", "NONE")), [
    { industry: "lobby", matched_on: "display_name" },
  ]);
  // Only lobby: the same super PAC's cause words elsewhere in its name stay unread.
  assert.deepEqual(industries(cmte("NRA VETERANS DEFENSE FUND", "O", "NONE")), ["lobby"]);
});

test("a lobby hit on both texts is one row, attributed to the sponsor", () => {
  assert.deepEqual(matchIndustryKeywords(cmte("NRA VICTORY FUND", "O", "NATIONAL RIFLE ASSOCIATION")), [
    { industry: "lobby", matched_on: "connected_org" },
  ]);
});

test("a sponsor that names two industries emits both — the UAW case FIX-1266 curates", () => {
  // "…AUTOMOBILE AEROSPACE…" hits defense; "UNION"/"WORKERS" hit labor. The
  // override table carries UAW Education Fund → labor (cc-196 D1).
  assert.deepEqual(
    industries(cmte("UAW EDUCATION FUND", "O", "INT'L UNION UNITED AUTOMOBILE AEROSPACE & AGRICULTURAL IMPLEMENT WORKERS OF AMERICA UAW")),
    ["defense", "labor"],
  );
});

test("the committee type is read case- and space-insensitively", () => {
  assert.equal(keywordMatchSource(cmte("WORKERS VOTE", " o ", null)), null);
  assert.equal(keywordMatchSource(cmte("WORKERS VOTE", "w", "NONE")), null);
});

test("the pre-read's entity_type filter covers every sponsor-matched type", () => {
  // tagFinancialEntities reads the O/U/V/W set WHERE entity_type IN ('pac',
  // 'super_pac'). If the writer ever maps one of these elsewhere, that committee
  // silently falls back to its display name.
  for (const t of SPONSOR_MATCHED_CMTE_TYPES) {
    assert.ok(["pac", "super_pac"].includes(cmteTypeToEntityType(t)), `${t} → ${cmteTypeToEntityType(t)}`);
  }
  assert.deepEqual([...SPONSOR_MATCHED_CMTE_TYPES].sort(), ["O", "U", "V", "W"]);
});

test("every sponsor-name industry is a keyword list", () => {
  for (const ind of SPONSOR_NAME_INDUSTRIES) assert.ok(ind in INDUSTRY_KEYWORDS, ind);
});
