// Shared entity-label resolver (FIX-597). Extracted verbatim from the homepage
// Commons module (FIX-595, apps/civitics/app/page.tsx) so the homepage and the
// Citizen Desk (Receipts + Watching modules) resolve a polymorphic
// (entity_type, entity_id) into a display label + entity href from ONE source
// of truth — no second copy of the table/col/base config to drift.
//
// Quirks preserved from the original inline map:
//   * financial_entity → financial_entities.display_name (not name), base /donors
//   * district         → jurisdictions.name (district rows live in jurisdictions),
//                        base /districts (distinct from the /jurisdictions base)
//
// `href` is the ENTITY href only (`${base}/${id}`) — NO comment anchor. Callers
// that link to a specific comment (the Commons ledger) append their own
// `#comment-${commentId}`.

export const COMMONS_ENTITY = {
  proposal:         { chip: "PROPOSAL",      table: "proposals",          col: "title",        base: "/proposals" },
  official:         { chip: "OFFICIAL",      table: "officials",          col: "full_name",    base: "/officials" },
  agency:           { chip: "AGENCY",        table: "agencies",           col: "name",         base: "/agencies" },
  jurisdiction:     { chip: "JURISDICTION",  table: "jurisdictions",      col: "name",         base: "/jurisdictions" },
  institution:      { chip: "INSTITUTION",   table: "institutions",       col: "name",         base: "/institutions" },
  financial_entity: { chip: "DONOR",         table: "financial_entities", col: "display_name", base: "/donors" },
  district:         { chip: "DISTRICT",      table: "jurisdictions",      col: "name",         base: "/districts" },
  investigation:    { chip: "INVESTIGATION", table: "investigations",     col: "title",        base: "/investigations" },
} as const;

export type CommonsEntityType = keyof typeof COMMONS_ENTITY;

export type ResolvedEntity = { label: string; href: string; chip: string };

export function isCommonsEntityType(t: string): t is CommonsEntityType {
  return t in COMMONS_ENTITY;
}

// Minimal structural type — a supabase-js client narrowed to the one call shape
// this helper makes. Callers pass their already-`as any`-cast client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LabelClient = { from: (table: string) => any };

/**
 * Resolve a batch of polymorphic entity refs into `{ label, href, chip }`.
 * Runs ONE query per present entity_type. Rows whose entity_type isn't a
 * known Commons type are skipped. Unresolved ids (deleted / mismatched) are
 * simply absent from the returned map — callers should skip rather than link
 * to a 404.
 *
 * @returns Map keyed by `${entity_type}:${entity_id}`.
 */
export async function resolveEntityLabels(
  client: LabelClient,
  rows: { entity_type: string; entity_id: string }[]
): Promise<Map<string, ResolvedEntity>> {
  const idsByType = new Map<CommonsEntityType, Set<string>>();
  for (const r of rows) {
    if (!isCommonsEntityType(r.entity_type)) continue;
    const set = idsByType.get(r.entity_type) ?? new Set<string>();
    set.add(r.entity_id);
    idsByType.set(r.entity_type, set);
  }

  const out = new Map<string, ResolvedEntity>();
  await Promise.all(
    [...idsByType.entries()].map(async ([et, ids]) => {
      const cfg = COMMONS_ENTITY[et];
      const { data } = await client.from(cfg.table).select(`id,${cfg.col}`).in("id", [...ids]);
      for (const row of (data ?? []) as Record<string, string>[]) {
        const label = row[cfg.col];
        if (label) {
          out.set(`${et}:${row.id}`, {
            label,
            href: `${cfg.base}/${row.id}`,
            chip: cfg.chip,
          });
        }
      }
    })
  );
  return out;
}
