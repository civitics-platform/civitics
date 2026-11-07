/**
 * Reading routine text out of a migration file, for source-anchor tests.
 *
 * `body()` and `header()` are copied verbatim from work-mem-allowances.test.ts
 * (FIX-1307 / cc-223), where they are not exported. Only job-registry-seed.test.ts
 * imports this today; moving the existing tests onto it is a later hygiene line.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

export const read = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

/** A routine's body, between its opening and closing dollar-quote (`$function$`, `$procedure$` or `$$`). */
export function body(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine not found: ${signature}`);
  const m = src.slice(i).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, `no dollar-quoted body after ${signature}`);
  return m[2] as string;
}

/** The header between the signature and `AS $…$` — where a SET clause would sit. */
export function header(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine not found: ${signature}`);
  return src.slice(i, src.indexOf("AS $", i));
}

/** `--` comments removed, so an anchor never matches prose. */
export const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");

/**
 * The pins that moved after files already asserted them: old md5 → the live body.
 * cc-264: box_is_saturated (fix1354 → the io: rung) and prod_op_gate (fix1342 → the
 * (d) re-cut). A migration's read-back is history and is never edited, but a clone
 * test re-applies that file against the clone's CURRENT bodies, so its read-back
 * must assert them. Add a line when a pin moves.
 */
export const PIN_LINEAGE: Readonly<Record<string, string>> = {
  ac8dbcddf71978e73d28c999433156b7: "aaf6cc6552df532eff4a9b21e9780670",
  "1d3507cd4b71439f0cfff51cde49b9d8": "6488601cf8c09287d540989c0e0fd074",
};

export const atCurrentPins = (sql: string): string =>
  Object.entries(PIN_LINEAGE).reduce((s, [was, now]) => s.split(was).join(now), sql);

/** A pg client whose every SQL string runs at the current pins (see PIN_LINEAGE). */
export function withCurrentPins<T extends { query: unknown }>(client: T): T {
  const query = (client.query as (...a: unknown[]) => unknown).bind(client);
  client.query = (sql: unknown, ...rest: unknown[]) =>
    query(typeof sql === "string" ? atCurrentPins(sql) : sql, ...rest);
  return client;
}
