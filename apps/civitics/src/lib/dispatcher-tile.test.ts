/**
 * FIX-1308 — the read-only /dashboard dispatcher tile, wired end to end.
 *
 * get_ec_crawl_health (FIX-1114) is the cautionary precedent: it is computed in
 * every status snapshot and rendered nowhere, because a section has five places
 * to be wired and it reached two. This file pins all five for `dispatcher`:
 *
 *   1. sections.ts       getDispatcher() = one RPC, get_dispatcher_status, null on error
 *   2. status-snapshot   a sectionTasks entry AND a payload assembly line
 *   3. /core route       plucks it (the client's mount fetch REPLACES the SSR status
 *                        with /core + /quality — a key on neither vanishes on refresh)
 *   4. page.tsx          maps it into the SSR seed
 *   5. useDashboardData  maps core.dispatcher, and DashboardClient renders the section
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "..", "..");
const src = (...p: string[]) =>
  readFileSync(join(APP, ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("FIX-1308: getDispatcher is one RPC to get_dispatcher_status, null on error", () => {
  const s = src("app", "api", "claude", "status", "_lib", "sections.ts");
  const i = s.indexOf("export async function getDispatcher(");
  assert.ok(i > 0, "getDispatcher is exported");
  const body = s.slice(i, s.indexOf("\n}\n", i));
  assert.match(body, /db\.rpc\("get_dispatcher_status"\)/);
  assert.match(body, /if \(error \|\| !data\) return null;/);
  assert.equal((body.match(/db\.(rpc|from)\(/g) ?? []).length, 1, "one bounded read");
});

test("FIX-1308: the status half computes and assembles the dispatcher section", () => {
  const s = src("app", "api", "claude", "status", "_lib", "status-snapshot.ts");
  assert.match(s, /dispatcher\?: Sectioned<Awaited<ReturnType<typeof getDispatcher>>>;/);
  assert.match(s, /\["dispatcher", \(\) => timed\("dispatcher", \(\) => getDispatcher\(dbAsDb\)\)\]/);
  assert.match(s, /dispatcher: byKey\.dispatcher as StatusPayload\["dispatcher"\],/);
});

test("FIX-1308: /core, the SSR seed and the client refresh all carry it, and the client renders it", () => {
  assert.match(src("app", "api", "claude", "status", "core", "route.ts"), /dispatcher: payload\.dispatcher,/);
  assert.match(src("app", "dashboard", "page.tsx"), /dispatcher: payload\.dispatcher as any,/);
  const hook = src("app", "dashboard", "useDashboardData.ts");
  assert.match(hook, /dispatcher\?: DispatcherStatus \| null \| PartialError;/);
  assert.match(hook, /dispatcher: core\.dispatcher,/);
  const client = src("app", "dashboard", "DashboardClient.tsx");
  assert.match(client, /function DispatcherSection\(/);
  assert.match(client, /<DispatcherSection\s+dispatcher=\{/);
});

test("FIX-1316: the dials type and the tile carry rearm_cooldown_seconds (optional — older snapshots lack it)", () => {
  assert.match(src("app", "dashboard", "useDashboardData.ts"), /rearm_cooldown_seconds\?: number;/);
  assert.match(src("app", "dashboard", "DashboardClient.tsx"), /re-arm cooldown \{d\.dials\.rearm_cooldown_seconds\} s/);
});

test("FIX-1308: the tile is read-only — no fetch, no rpc, no mutation inside the section", () => {
  const client = src("app", "dashboard", "DashboardClient.tsx");
  const i = client.indexOf("function DispatcherSection(");
  const body = client.slice(i, client.indexOf("\nfunction ", i + 10) > 0 ? client.indexOf("\nfunction ", i + 10) : client.indexOf("export function DashboardClient", i));
  assert.doesNotMatch(body, /fetch\(|\.rpc\(|method: "POST"|onClick/);
});
