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
