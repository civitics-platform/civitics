/**
 * FIX-1432 — the pipelines' primary-source refresh goes by direct pg, bounded
 * at 60 s, never through PostgREST (where the authenticator's 8 s cancelled it:
 * the 2026-11-16 regulations nightly, n=1003). No database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshPrimarySourceOn, REFRESH_PRIMARY_SOURCE_TIMEOUT } from "./direct-pg-upsert";

test("the refresh sets its own 60 s bound before it calls the function", async () => {
  const sent: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      sent.push({ sql, params });
      return { rows: sql.startsWith("SELECT") ? [{ n: 7 }] : [] };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const n = await refreshPrimarySourceOn(client as any, "proposal", ["00000000-0000-0000-0000-000000000001"]);
  assert.equal(REFRESH_PRIMARY_SOURCE_TIMEOUT, "60s");
  assert.equal(n, 7);
  assert.deepEqual(
    sent.map((s) => s.sql),
    [
      "SET statement_timeout = '60s'",
      "SELECT public.refresh_primary_source_for_entities($1, $2::uuid[]) AS n",
    ],
  );
  assert.deepEqual(sent[1]!.params, ["proposal", ["00000000-0000-0000-0000-000000000001"]]);
});

test("no file under pipelines/ refreshes primary_source through PostgREST", () => {
  const dir = fileURLToPath(new URL("../pipelines", import.meta.url));
  const files = readdirSync(dir, { recursive: true })
    .filter((f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
  assert.ok(files.length > 50, `expected the pipelines tree, found ${files.length} files`);

  const offenders: string[] = [];
  for (const f of files) {
    // Comments may name the wrapper; code may not.
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (/refreshPrimarySourceForEntities/.test(code)) offenders.push(`${f}: the @civitics/db wrapper`);
    if (/\.rpc\(\s*["'`]refresh_primary_source_for_entities["'`]/.test(code)) offenders.push(`${f}: .rpc("refresh_primary_source_for_entities")`);
  }
  assert.deepEqual(offenders, [], "use refreshPrimarySourceDirect (lib/direct-pg-upsert.ts)");
});
