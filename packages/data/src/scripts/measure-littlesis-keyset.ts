/**
 * FIX-1159 measurement harness — the before/after for the LittleSis match index.
 *
 * Builds the index one way (filtered or unfiltered), then streams the SAME
 * entities dump through the real `matchPerson` / `matchOrg` and hashes every
 * result. Two runs that print the same `match_sha256` produced byte-identical
 * match output for every entity in the dump — equality, not closeness.
 *
 *   tsx --env-file=../../.env.local src/scripts/measure-littlesis-keyset.ts \
 *       --entities <path-to-entities.json.gz> [--unfiltered]
 *
 * Reads whichever DB `.env.local` points at, via the same `buildDbUrl()` the
 * pipeline uses. Run it against the local prod-clone.
 */

import { createHash } from "node:crypto";
import { buildMatchIndex, collectLittleSisPersonKeys, matchPerson, matchOrg } from "../pipelines/littlesis/matcher";
import { streamGzipJson, type LittleSisEntity } from "../pipelines/littlesis/util";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const entitiesPath = arg("--entities");
  if (!entitiesPath) {
    console.error("--entities <path to entities.json.gz> is required");
    process.exit(2);
  }
  const unfiltered = process.argv.includes("--unfiltered");
  const label = unfiltered ? "BEFORE (unfiltered)" : "AFTER (FIX-1159 key-set filter)";

  console.log(`\n=== ${label} ===`);

  // Pass 1 — always run it, so its cost is on the record for both arms even
  // when the result is discarded. It is the price the filter charges.
  const keyT0 = process.hrtime.bigint();
  const personKeys = await collectLittleSisPersonKeys(entitiesPath);
  const keySecs = Number(process.hrtime.bigint() - keyT0) / 1e9;

  // Pass 2 — the index itself.
  const buildT0 = process.hrtime.bigint();
  const idx = await buildMatchIndex(unfiltered ? undefined : personKeys);
  const buildSecs = Number(process.hrtime.bigint() - buildT0) / 1e9;
  const rssAfterBuild = process.memoryUsage().rss / 1024 / 1024;

  // Match every entity and hash the outcome stream.
  const hash = createHash("sha256");
  const tally = {
    persons_seen: 0,
    orgs_seen: 0,
    person_high: 0,
    person_medium: 0,
    person_queue: 0,
    person_miss: 0,
    person_matched_fe: 0,
    person_matched_official: 0,
    org_high: 0,
    org_medium: 0,
    org_queue: 0,
    org_miss: 0,
  };

  for await (const ent of streamGzipJson<LittleSisEntity>(entitiesPath)) {
    if (!ent || typeof ent.id !== "number") continue;
    if (ent.primary_ext === "Person") {
      tally.persons_seen++;
      const m = matchPerson(ent, idx);
      hash.update(`${ent.id}|${JSON.stringify(m)}\n`);
      if (m.kind === "high") tally.person_high++;
      else if (m.kind === "medium") tally.person_medium++;
      else if (m.kind === "queue") tally.person_queue++;
      else tally.person_miss++;
      if (m.kind === "high" || m.kind === "medium") {
        if (m.civitics_type === "financial_entity") tally.person_matched_fe++;
        else tally.person_matched_official++;
      }
    } else if (ent.primary_ext === "Org") {
      tally.orgs_seen++;
      const m = matchOrg(ent, idx);
      hash.update(`${ent.id}|${JSON.stringify(m)}\n`);
      if (m.kind === "high") tally.org_high++;
      else if (m.kind === "medium") tally.org_medium++;
      else if (m.kind === "queue") tally.org_queue++;
      else tally.org_miss++;
    }
  }

  const peakRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  console.log(
    JSON.stringify(
      {
        arm: unfiltered ? "unfiltered" : "filtered",
        keyset_build_s: +keySecs.toFixed(1),
        keyset_size: personKeys.size,
        index_build_s: +buildSecs.toFixed(1),
        rss_after_build_mb: Math.round(rssAfterBuild),
        rss_end_mb: peakRssMb,
        officials_keys: idx.officialsByLastName.size,
        persons_keys: idx.personsBySortKey.size,
        orgs_keys: idx.orgsByCanonical.size,
        ...tally,
        match_sha256: hash.digest("hex"),
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
