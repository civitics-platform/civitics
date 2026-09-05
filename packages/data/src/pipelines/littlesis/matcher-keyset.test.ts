// FIX-1159 regression test — filtering `personsBySortKey` down to the keys the
// LittleSis dump can actually ask about does not change a single match.
//
// The claim being proved: `matchPerson` is the ONLY reader of that map, and it
// only ever looks up `personSortKey(canonicalizeEntityName(ent.name))` for a
// LittleSis Person entity. So an individual whose key is not in that set could
// never have been returned, and dropping it is invisible to the output. This
// test runs the real `matchPerson` against a full index and a filtered one and
// asserts they agree entity-for-entity — equality, not closeness.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  matchPerson,
  personSortKey,
  collectLittleSisPersonKeys,
  type MatchIndex,
  type FinancialEntityRow,
  type OfficialRow,
} from "./matcher";
import { canonicalizeEntityName } from "../fec-bulk/writer";
import type { LittleSisEntity } from "./util";

// ── Fixtures ────────────────────────────────────────────────────────────────

function lsPerson(id: number, name: string): LittleSisEntity {
  return { id, name, primary_ext: "Person" };
}
function lsOrg(id: number, name: string): LittleSisEntity {
  return { id, name, primary_ext: "Org" };
}

/** The LittleSis dump this run would see. */
const LS_ENTITIES: LittleSisEntity[] = [
  lsPerson(1, "Elon Musk"),
  lsPerson(2, "Sheldon Adelson"),
  lsPerson(3, "Penny Pritzker"),
  lsPerson(4, "George Soros"),
  lsPerson(5, "Madonna"), // single token — matchPerson bails before the map
  lsOrg(6, "Acme Corporation"), // Org — never touches personsBySortKey
];

/**
 * The Civitics donor side. Deliberately mixes people LittleSis asks about with
 * a bulk of people it does not — the 4.9M-individual reality in miniature.
 */
const FE_INDIVIDUALS: FinancialEntityRow[] = [
  // Surname-first FEC spelling of a LittleSis name — the case personSortKey
  // exists for. Key "ELON MUSK" either way.
  { id: "fe-musk", canonical_name: canonicalizeEntityName("MUSK ELON"), entity_type: "individual" },
  // The SAME human with a middle initial. FIX-239 deliberately keeps initials
  // in the canonical name, so this keys to "ELON MUSK R" and has never matched
  // a bare "Elon Musk" — before this change or after it. It is in the fixture
  // precisely because the filter drops it: a row the full index could not match
  // either, so dropping it is invisible, which is the whole claim.
  { id: "fe-musk-initial", canonical_name: canonicalizeEntityName("MUSK ELON R"), entity_type: "individual" },
  // Two spellings of one donor collide on "ADELSON SHELDON" → the review queue.
  { id: "fe-adelson", canonical_name: canonicalizeEntityName("ADELSON SHELDON"), entity_type: "individual" },
  { id: "fe-adelson-2", canonical_name: canonicalizeEntityName("SHELDON ADELSON"), entity_type: "individual" },
  { id: "fe-soros", canonical_name: canonicalizeEntityName("SOROS GEORGE"), entity_type: "individual" },
  // Nobody LittleSis has heard of — the 4.9M-row bulk the filter is meant to
  // drop, in miniature.
  ...Array.from({ length: 500 }, (_, i) => ({
    id: `fe-noise-${i}`,
    canonical_name: canonicalizeEntityName(`NOISE${i} PERSON${i}`),
    entity_type: "individual",
  })),
];

const FE_ORGS: FinancialEntityRow[] = [
  { id: "fe-acme", canonical_name: canonicalizeEntityName("Acme Corporation"), entity_type: "corporation" },
];

/** Pritzker is an OFFICIAL, so matchPerson returns before reaching the donor map. */
const OFFICIALS: OfficialRow[] = [
  {
    id: "off-pritzker",
    full_name: "Penny Pritzker",
    first_name: "Penny",
    last_name: "Pritzker",
    state_abbr: "IL",
    role_title: "Secretary",
  },
];

/**
 * Build a MatchIndex the same way buildMatchIndex's loop does — optionally
 * applying the FIX-1159 retain filter. Mirroring the loop rather than calling
 * buildMatchIndex keeps this a pure unit test (that function opens a pg
 * connection).
 */
function makeIndex(personKeys?: ReadonlySet<string>): MatchIndex {
  const officialsByLastName = new Map<string, OfficialRow[]>();
  const personsBySortKey = new Map<string, FinancialEntityRow[]>();
  const orgsByCanonical = new Map<string, FinancialEntityRow[]>();

  for (const o of OFFICIALS) {
    const last = (o.last_name ?? "").toUpperCase().replace(/[^A-Z]/g, "");
    officialsByLastName.set(last, [...(officialsByLastName.get(last) ?? []), o]);
  }
  for (const r of [...FE_INDIVIDUALS, ...FE_ORGS]) {
    if (!r.canonical_name) continue;
    if (r.entity_type === "individual") {
      const key = personSortKey(r.canonical_name);
      if (!key) continue;
      if (personKeys && !personKeys.has(key)) continue; // ← the FIX-1159 lever
      personsBySortKey.set(key, [...(personsBySortKey.get(key) ?? []), r]);
    } else {
      orgsByCanonical.set(r.canonical_name, [...(orgsByCanonical.get(r.canonical_name) ?? []), r]);
    }
  }
  return { officialsByLastName, personsBySortKey, orgsByCanonical };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("FIX-1159 — collectLittleSisPersonKeys", () => {
  const path = join(tmpdir(), `ls-keyset-test-${process.pid}.json.gz`);

  it("collects a key for every 2+-token Person, and nothing else", async () => {
    writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(LS_ENTITIES), "utf8")));
    try {
      const keys = await collectLittleSisPersonKeys(path);

      // Orgs contribute nothing.
      assert.equal(keys.has(personSortKey(canonicalizeEntityName("Acme Corporation"))), false);
      // Single-token people contribute nothing — matchPerson bails on them
      // before the map is consulted, so a key would be unusable anyway.
      assert.equal(keys.has(personSortKey(canonicalizeEntityName("Madonna"))), false);

      // The four real people are all present, keyed order-insensitively.
      for (const name of ["Elon Musk", "Sheldon Adelson", "Penny Pritzker", "George Soros"]) {
        assert.ok(keys.has(personSortKey(canonicalizeEntityName(name))), `missing key for ${name}`);
      }
      assert.equal(keys.size, 4);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("keys are order-insensitive, so FIRST-LAST finds a LAST-FIRST donor", () => {
    assert.equal(
      personSortKey(canonicalizeEntityName("Elon Musk")),
      personSortKey(canonicalizeEntityName("MUSK ELON")),
    );
  });
});

describe("FIX-1159 — the filtered index matches identically", () => {
  const path = join(tmpdir(), `ls-keyset-eq-${process.pid}.json.gz`);

  it("matchPerson agrees entity-for-entity, full index vs filtered", async () => {
    writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(LS_ENTITIES), "utf8")));
    let keys: Set<string>;
    try {
      keys = await collectLittleSisPersonKeys(path);
    } finally {
      rmSync(path, { force: true });
    }

    const full = makeIndex();
    const filtered = makeIndex(keys);

    // The filter is doing real work — otherwise this test proves nothing.
    // Full: ELON MUSK, ELON MUSK R, ADELSON SHELDON, GEORGE SOROS + 500 noise.
    assert.equal(full.personsBySortKey.size, 504);
    // Filtered: only the three keys the dump can ask about. "ELON MUSK R" goes
    // too — LittleSis never asks for it.
    assert.equal(filtered.personsBySortKey.size, 3);
    assert.equal(full.orgsByCanonical.size, filtered.orgsByCanonical.size, "org side untouched");

    for (const ent of LS_ENTITIES) {
      assert.deepEqual(
        matchPerson(ent, filtered),
        matchPerson(ent, full),
        `match differed for LittleSis entity ${ent.id} (${ent.name})`,
      );
    }
  });

  it("the specific outcomes are the ones we expect (not all 'miss')", async () => {
    writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(LS_ENTITIES), "utf8")));
    let keys: Set<string>;
    try {
      keys = await collectLittleSisPersonKeys(path);
    } finally {
      rmSync(path, { force: true });
    }
    const filtered = makeIndex(keys);

    // A single donor hit → medium on the financial_entity.
    assert.deepEqual(matchPerson(lsPerson(1, "Elon Musk"), filtered), {
      kind: "medium",
      civitics_type: "financial_entity",
      civitics_id: "fe-musk",
    });

    // Two donor rows share a sort key → the human-review queue, preserved.
    const adelson = matchPerson(lsPerson(2, "Sheldon Adelson"), filtered);
    assert.equal(adelson.kind, "queue");

    // An official beats the donor map and returns before it is consulted.
    const pritzker = matchPerson(lsPerson(3, "Penny Pritzker"), filtered);
    assert.equal(pritzker.kind === "medium" && pritzker.civitics_type, "official");

    // Single-token entries stay a miss.
    assert.deepEqual(matchPerson(lsPerson(5, "Madonna"), filtered), { kind: "miss" });
  });
});
