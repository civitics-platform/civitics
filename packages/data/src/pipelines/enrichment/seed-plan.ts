/**
 * FIX-1158 — the seeder's pure decisions, split out so they can be tested.
 *
 * `seed-backlog.ts` calls `main()` at module scope, so importing it from a test
 * would run the seeder. Everything here is side-effect free and imported BY it.
 *
 * The decision that matters is `financialEntityPopulation`. The seeder's
 * financial-entity arm walks `financial_entities` (5,204,854 rows on prod
 * 2026-09-04) and enqueues every row that lacks an industry tag. Individuals
 * are 4,975,895 of that table and NONE of them carry an industry tag, so before
 * this fix the DEFAULT path of a manually-run script staged ~4.98 million rows
 * of downstream drain work — each one a model call — and `--pacs-only` was an
 * opt-in flag that defaulted OFF.
 *
 * Individuals are not a legitimate member of that queue, and that is measured:
 *
 *   - the rule tagger is explicitly scoped to non-individual entities
 *     (`tags/rules.ts`, FIX-437), against a partial index built for exactly
 *     that predicate: `WHERE entity_type <> 'individual'`;
 *   - on the prod clone (2026-09-05) industry tags cover corporation 29,157 /
 *     other 9,184 / pac 2,918 / union 167 / super_pac 130 / party_committee 77
 *     / nonprofit 3, and `individual` ZERO — against 3,453,892 individuals;
 *   - every `financial_entity` row already in `enrichment_queue` is
 *     non-individual.
 */

/** Which financial_entities the seeder's industry-tag arm will walk. */
export type FePopulation =
  /** --pacs-only: PAC + party_committee, priority 100. */
  | { kind: "pacs_only"; entityTypes: string[] }
  /** The default: everything except individuals. */
  | { kind: "exclude_individuals"; excludedEntityType: string }
  /** --all-financial-entities: the old behaviour, opt-in and loud. */
  | { kind: "all" };

/**
 * The population predicate. It is expressed as a filter on the QUERY rather
 * than a post-filter deliberately: `.neq("entity_type", "individual")` shrinks
 * the FIX-984 keyset walk itself from 5.2M rows to ~229k, instead of streaming
 * five million rows in order to throw them away.
 *
 * `--pacs-only` wins over `--all-financial-entities` — it is the narrower of
 * the two and a caller who passed both asked for a subset either way.
 */
export function financialEntityPopulation(opts: {
  pacsOnly: boolean;
  allFinancialEntities: boolean;
}): FePopulation {
  if (opts.pacsOnly) return { kind: "pacs_only", entityTypes: ["pac", "party_committee"] };
  if (opts.allFinancialEntities) return { kind: "all" };
  return { kind: "exclude_individuals", excludedEntityType: "individual" };
}

/** Parse `--max-enqueue N`, defaulting to DEFAULT_MAX_ENQUEUE. Throws on junk. */
export const DEFAULT_MAX_ENQUEUE = 50_000;

export function parseMaxEnqueue(argv: string[]): number {
  const i = argv.indexOf("--max-enqueue");
  if (i === -1) return DEFAULT_MAX_ENQUEUE;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (raw === undefined || raw.startsWith("--") || !Number.isFinite(n) || n < 0) {
    throw new Error(`--max-enqueue needs a non-negative number, got: ${raw ?? "(nothing)"}`);
  }
  return n;
}

/**
 * Would this plan be allowed to run?
 *
 * `--force` is the override. It already means "reseed done items", which only
 * ever makes a plan BIGGER — so a caller who passes it has, by construction,
 * asked for the larger run. Preferring `--max-enqueue <n>` is still the better
 * habit because it records the number that was agreed to.
 */
export function ceilingVerdict(
  total: number,
  maxEnqueue: number,
  force: boolean,
): "ok" | "refuse" {
  return total > maxEnqueue && !force ? "refuse" : "ok";
}

/** One planned row, reduced to what the plan table reports on. */
export type PlanRowKey = { entity_type: string; task_type: string; priority: number };

/**
 * FIX-1158 — the count you get to see BEFORE anything is written, broken down
 * by entity_type and priority. Those are the two axes that decide what an
 * enqueue actually costs: the type says what kind of work it is, the priority
 * says how soon the drain reaches it.
 */
export function formatPlanTable(rows: PlanRowKey[]): string {
  const byKey = new Map<string, PlanRowKey & { n: number }>();
  for (const r of rows) {
    const key = `${r.entity_type}|${r.task_type}|${r.priority}`;
    const hit = byKey.get(key);
    if (hit) hit.n++;
    else byKey.set(key, { ...r, n: 1 });
  }
  const grouped = [...byKey.values()].sort(
    (a, b) =>
      a.entity_type.localeCompare(b.entity_type) ||
      a.task_type.localeCompare(b.task_type) ||
      b.priority - a.priority,
  );
  const total = grouped.reduce((sum, r) => sum + r.n, 0);

  const lines = [
    "   entity_type       task_type   priority        rows",
    "   -----------------------------------------------------",
  ];
  if (grouped.length === 0) lines.push("   (nothing to enqueue)");
  for (const r of grouped) {
    lines.push(
      `   ${r.entity_type.padEnd(18)}${r.task_type.padEnd(12)}${String(r.priority).padStart(8)}` +
        `${r.n.toLocaleString().padStart(12)}`,
    );
  }
  lines.push("   -----------------------------------------------------");
  lines.push(`   ${"TOTAL".padEnd(38)}${total.toLocaleString().padStart(12)}`);
  return lines.join("\n");
}
