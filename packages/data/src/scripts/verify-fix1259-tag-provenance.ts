/**
 * FIX-1259 — a tag writer overwrites only rows of its own provenance. Run
 * against the LOCAL clone, inside one transaction that is always rolled back.
 *
 *   (a) an existing ai row + an incoming rule row on the same key → the ai row
 *       is byte-identical afterwards (generated_by, confidence, ai_model,
 *       metadata), and the statement writes 0 rows for it;
 *   (b) an existing rule row + an incoming rule row with new metadata → updated;
 *   (c) no existing row → inserted;
 *   (d) WRONG-BUT-GREEN: `--old-builder` runs the pre-FIX-1259 statement (the
 *       same spec with no updateOnlyIfSame). (a) must go RED — the ai row comes
 *       back as 'rule' — or the fixture proves nothing.
 *
 * Fixture entity ids are synthetic (f1259…); entity_tags has no FK to
 * financial_entities.
 *
 * Run: pnpm --filter @civitics/data data:verify:tag-provenance [-- --old-builder]
 */

import { Client } from "pg";
import { bulkUpsert } from "../lib/direct-pg-upsert";
import { upsertTags, type TagInsert } from "../pipelines/tags/rules";

const OLD_BUILDER = process.argv.includes("--old-builder");

const id = (n: number) => `f1259000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AI_HELD = id(1);   // (a)
const RULE_HELD = id(2); // (b)
const EMPTY = id(3);     // (c)
const IDS = [AI_HELD, RULE_HELD, EMPTY];

let failures = 0;
function check(cond: boolean, label: string, detail?: string): void {
  if (cond) console.info(`  PASS  ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const ruleTag = (entity_id: string, tag: string, naics: string): TagInsert => ({
  entity_type: "financial_entity",
  entity_id,
  tag,
  tag_category: "industry",
  display_label: tag,
  display_icon: null,
  visibility: "primary",
  generated_by: "rule",
  confidence: 0.85,
  pipeline_version: "v1",
  metadata: { naics_code: naics },
});

type Row = { generated_by: string; confidence: string; ai_model: string | null; metadata: unknown; tag: string };

async function rowsFor(pg: Client, entityId: string): Promise<Row[]> {
  return (await pg.query<Row>(
    `SELECT tag, generated_by, confidence::text, ai_model, metadata
       FROM public.entity_tags
      WHERE entity_type = 'financial_entity' AND entity_id = $1 AND tag_category = 'industry'
      ORDER BY tag`,
    [entityId],
  )).rows;
}

/**
 * upsertTags' bulkUpsert spec, with or without the FIX-1259 predicate. Without
 * it, this IS the pre-FIX-1259 upsertTags body. Returns rows the server wrote,
 * and throws on a failed chunk — a chunk that fails also "writes 0 rows", which
 * is the wrong-but-green this harness must not fall for.
 */
async function specUpsert(pg: Client, tags: TagInsert[], guarded: boolean): Promise<number> {
  const { changed, failed } = await bulkUpsert(pg, {
    table: "entity_tags",
    columns: ["entity_type", "entity_id", "tag", "tag_category", "display_label", "display_icon",
              "visibility", "generated_by", "confidence", "pipeline_version", "metadata"],
    conflictColumns: ["entity_type", "entity_id", "tag", "tag_category"],
    ...(guarded ? { updateOnlyIfSame: ["generated_by"] } : {}),
    jsonbColumns: ["metadata"],
    rows: tags.map((t) => [t.entity_type, t.entity_id, t.tag, t.tag_category, t.display_label,
                           t.display_icon, t.visibility, t.generated_by, t.confidence,
                           t.pipeline_version, t.metadata]),
    label: guarded ? "entity_tags" : "entity_tags (pre-FIX-1259)",
  });
  if (failed > 0) throw new Error(`fixture upsert: ${failed} row(s) failed — the count below would be meaningless`);
  return changed;
}

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
    throw new Error(`verify-fix1259-tag-provenance is LOCAL ONLY (active env: ${url || "unset"}).`);
  }
  const pg = new Client({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    application_name: "verify_fix1259_tag_provenance",
  });
  await pg.connect();
  console.info(`FIX-1259 provenance fixtures — ${OLD_BUILDER ? "PRE-FIX statement (--old-builder): expect (a) RED" : "current upsertTags"}`);

  try {
    await pg.query("BEGIN");
    await pg.query(
      `INSERT INTO public.entity_tags
         (entity_type, entity_id, tag, tag_category, display_label, visibility, generated_by,
          confidence, ai_model, pipeline_version, metadata)
       VALUES ('financial_entity', $1, 'defense', 'industry', 'Defense', 'primary', 'ai',
               0.93, 'claude-haiku-4-5-20251001', 'v1', '{"reasoning":"fixture: ai judgment"}'),
              ('financial_entity', $2, 'tech', 'industry', 'tech', 'primary', 'rule',
               0.85, NULL, 'v1', '{"naics_code":"541512"}')`,
      [AI_HELD, RULE_HELD],
    );
    const aiBefore = await rowsFor(pg, AI_HELD);

    // The single-row statement for (a) alone, so its written count is (a)'s.
    await pg.query("SAVEPOINT a_alone");
    const aChanged = await specUpsert(pg, [ruleTag(AI_HELD, "defense", "541712")], !OLD_BUILDER);
    await pg.query("ROLLBACK TO SAVEPOINT a_alone");

    // The three together, through the real writer (or the pre-fix statement).
    const batch = [
      ruleTag(AI_HELD, "defense", "541712"),
      ruleTag(RULE_HELD, "tech", "541519"),
      ruleTag(EMPTY, "health", "524114"),
    ];
    // FIX-1273: the kept count upsertTags returns is the server's rowCount
    // shortfall — against a real table it must be exactly (a)'s one row.
    let kept: number | null = null;
    if (OLD_BUILDER) await specUpsert(pg, batch, false);
    else kept = (await upsertTags(pg, batch)).kept;

    console.info("\n=== (a) ai row + incoming rule on the same key ===");
    const aiAfter = await rowsFor(pg, AI_HELD);
    check(aiAfter.length === 1, "still exactly one row", `${aiAfter.length} rows`);
    check(aiAfter[0]?.generated_by === "ai", "generated_by stays 'ai'", `got '${aiAfter[0]?.generated_by}'`);
    check(JSON.stringify(aiAfter) === JSON.stringify(aiBefore), "row byte-identical (confidence, ai_model, metadata)",
      `before ${JSON.stringify(aiBefore)} after ${JSON.stringify(aiAfter)}`);
    check(aChanged === 0, "the statement writes 0 rows for it", `wrote ${aChanged}`);
    if (!OLD_BUILDER) check(kept === 1, "upsertTags reports it as kept: 1 (FIX-1273)", `kept ${kept}`);

    console.info("\n=== (b) rule row + incoming rule with new metadata ===");
    const ruleAfter = await rowsFor(pg, RULE_HELD);
    check(ruleAfter[0]?.generated_by === "rule" &&
          (ruleAfter[0]?.metadata as { naics_code?: string })?.naics_code === "541519",
      "updated to the incoming metadata", JSON.stringify(ruleAfter));

    console.info("\n=== (c) no existing row ===");
    const emptyAfter = await rowsFor(pg, EMPTY);
    check(emptyAfter.length === 1 && emptyAfter[0]?.generated_by === "rule" && emptyAfter[0]?.tag === "health",
      "inserted", JSON.stringify(emptyAfter));
  } finally {
    await pg.query("ROLLBACK");
    const left = await pg.query(`SELECT count(*)::int AS n FROM public.entity_tags WHERE entity_id = ANY ($1::uuid[])`, [IDS]);
    console.info(`\n  rolled back — fixture rows left: ${left.rows[0]?.n}`);
    await pg.end();
  }

  console.info(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
