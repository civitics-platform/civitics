/**
 * The proposal enums as the generated types state them, read off disk so a
 * test over "every value" grows with the schema.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TYPES = join(__dirname, "..", "..", "..", "..", "..", "packages", "db", "src", "types", "database.ts");

export function enumValues(name: "proposal_status" | "proposal_type"): string[] {
  const src = readFileSync(TYPES, "utf8").replace(/\r\n/g, "\n");
  const m = src.match(new RegExp(`\\n      ${name}:\\n((?:        \\| "[a-z_]+"\\n)+)`));
  if (!m) throw new Error(`enum ${name} not found in database.ts`);
  return [...(m[1] as string).matchAll(/"([a-z_]+)"/g)].map((x) => x[1] as string);
}
