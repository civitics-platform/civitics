import type { Check, CheckResult, CheckContext } from "../types";

const ENTITY_TABLES: Record<string, string> = {
  proposal: "proposals",
  official: "officials",
  agency: "agencies",
  financial_entity: "financial_entities",
};

async function orphansFor(
  ctx: CheckContext,
  table: string,
  entityIdColumn: string,
  entityIdCast: string,
): Promise<{ id: string; entity_type: string; entity_id: string }[]> {
  const orphans: { id: string; entity_type: string; entity_id: string }[] = [];
  const types = await ctx.query<{ entity_type: string }>(
    `SELECT DISTINCT entity_type FROM ${table} WHERE entity_type IS NOT NULL`,
  );
  for (const { entity_type } of types) {
    const target = ENTITY_TABLES[entity_type];
    if (!target) {
      const unknown = await ctx.query<{ id: string; entity_id: string }>(
        `SELECT id::text AS id, ${entityIdColumn}::text AS entity_id
           FROM ${table}
          WHERE entity_type = $1
          LIMIT 25`,
        [entity_type],
      );
      for (const row of unknown) {
        orphans.push({ id: row.id, entity_type, entity_id: row.entity_id });
      }
      continue;
    }
    const rows = await ctx.query<{ id: string; entity_id: string }>(
      `SELECT t.id::text AS id, t.${entityIdColumn}::text AS entity_id
         FROM ${table} t
        WHERE t.entity_type = $1
          AND NOT EXISTS (
            SELECT 1 FROM ${target} x WHERE x.id = t.${entityIdColumn}${entityIdCast}
          )`,
      [entity_type],
    );
    for (const row of rows) {
      orphans.push({ id: row.id, entity_type, entity_id: row.entity_id });
    }
  }
  return orphans;
}

export const referentialChecks: Check = async (ctx) => {
  const out: CheckResult[] = [];

  const entityTagOrphans = await orphansFor(ctx, "entity_tags", "entity_id", "");
  out.push({
    category: "referential.orphan_entity_tags",
    severity: entityTagOrphans.length === 0 ? "info" : "error",
    expected: 0,
    actual: entityTagOrphans.length,
    sample: entityTagOrphans.slice(0, 10),
    detail:
      "entity_tags rows whose (entity_type, entity_id) does not resolve to a row in proposals/officials/agencies.",
  });

  const aiCacheOrphans = await orphansFor(
    ctx,
    "ai_summary_cache",
    "entity_id",
    "",
  );
  out.push({
    category: "referential.orphan_ai_summary_cache",
    severity: aiCacheOrphans.length === 0 ? "info" : "error",
    expected: 0,
    actual: aiCacheOrphans.length,
    sample: aiCacheOrphans.slice(0, 10),
    detail:
      "ai_summary_cache rows whose (entity_type, entity_id) does not resolve.",
  });

  const queueOrphans = await orphansFor(
    ctx,
    "enrichment_queue",
    "entity_id",
    "::uuid",
  );
  out.push({
    category: "referential.orphan_enrichment_queue",
    severity: queueOrphans.length === 0 ? "info" : "error",
    expected: 0,
    actual: queueOrphans.length,
    sample: queueOrphans.slice(0, 10),
    detail:
      "enrichment_queue rows whose (entity_type, entity_id) does not resolve. Note: entity_id is TEXT in this table.",
  });

  // FIX-1427 — a promotion moves data_flags since 20261126005000; any other
  // delete of an officials row (a seed reset, a hand cleanup) still strands them.
  // Official refs only: governing_body has no ENTITY_TABLES entry.
  const flagOrphans = await ctx.query<{ id: string; entity_id: string }>(
    `SELECT d.id::text AS id, d.entity_id::text AS entity_id
       FROM data_flags d
      WHERE d.entity_type = 'official'
        AND NOT EXISTS (SELECT 1 FROM officials o WHERE o.id = d.entity_id)
      ORDER BY d.created_at, d.id`,
  );
  out.push({
    category: "referential.data_flags_orphan_officials",
    severity: flagOrphans.length === 0 ? "info" : "warning",
    expected: 0,
    actual: flagOrphans.length,
    sample: flagOrphans.slice(0, 10),
    detail:
      "data_flags rows with entity_type 'official' whose entity_id has no officials row (the admin queue shows '(name not found)'); official_redirects may name the survivor.",
  });

  return out;
};
