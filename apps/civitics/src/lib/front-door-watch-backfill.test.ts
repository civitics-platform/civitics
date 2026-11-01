/**
 * FIX-1348 (option b) — the first front-door-watch tick that can write says
 * what the wedge swallowed. Replays the 2026-10-25 gap from prod's
 * data_sync_log (read 2026-11-01): rows at 11:15:28.563 and 13:45:28.228, the
 * 13:45 row's buckets 12:45 / 13:00 / 13:15 RED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideBackfill,
  landBreadcrumb,
  TICK_MS,
  type BackfillCarry,
  type BreadcrumbIo,
} from "./front-door-breadcrumb";

const at = (iso: string) => Date.parse(iso);

// The 13:45:28 row's metadata, as prod holds it.
const CARRY_1345: BackfillCarry = {
  buckets: [
    { at: "2026-10-25T12:45:00.000Z", requests: 106, n_5xx: 105, n_52x: 105, red: true },
    { at: "2026-10-25T13:00:00.000Z", requests: 157, n_5xx: 156, n_52x: 156, red: true },
    { at: "2026-10-25T13:15:00.000Z", requests: 169, n_5xx: 168, n_52x: 167, red: true },
    { at: "2026-10-25T13:30:00.000Z", requests: 3680, n_5xx: 106, n_52x: 7, red: false },
  ],
  state: "ok",
  reason: "no sustained 52x, front door answering",
  mode: "arm",
  state_store:
    "unreachable: upstash 400: ERR max requests limit exceeded. Limit: 500000, Usage: 500001. " +
    "See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details",
};

/** A recording fake: the newest row's started_at (or a throw), and every INSERT. */
function io(newest: () => Promise<string | null>) {
  const inserts: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const fake: BreadcrumbIo = {
    newestStartedAt: async () => { order.push("read"); return newest(); },
    insert: async (metadata) => { order.push("insert"); inserts.push(metadata); },
  };
  return { fake, inserts, order };
}

test("FIX-1348 no gap: backfill is null, and the key is present on the row", async () => {
  const now = at("2026-11-01T00:00:28.488Z");
  const { fake, inserts, order } = io(async () => "2026-10-31T23:45:28.319+00:00");
  const backfill = await landBreadcrumb(fake, now, { source: "vercel_cron", state: "ok" }, CARRY_1345);
  assert.equal(backfill, null);
  assert.deepEqual(order, ["read", "insert"], "the read runs before this tick's own row exists");
  assert.equal(inserts.length, 1);
  assert.ok("backfill" in inserts[0]!);
  assert.equal(inserts[0]!["backfill"], null);
  assert.equal(inserts[0]!["source"], "vercel_cron", "the rest of the metadata rides unchanged");
});

test("FIX-1348 the 10-25 replay: 11:15:28 → 13:45:28 is 9 missed ticks, carrying the 13:45 row's buckets", () => {
  const b = decideBackfill(at("2026-10-25T11:15:28.563Z"), at("2026-10-25T13:45:28.228Z"), CARRY_1345);
  assert.ok(b && "missed_ticks" in b);
  assert.equal(b.missed_ticks, 9, "11:30 11:45 12:00 12:15 12:30 12:45 13:00 13:15 13:30");
  assert.equal(b.from, "2026-10-25T11:15:28.563Z");
  assert.equal(b.to, "2026-10-25T13:45:28.228Z");
  assert.deepEqual(b.buckets.filter((x) => x.red).map((x) => x.at), [
    "2026-10-25T12:45:00.000Z",
    "2026-10-25T13:00:00.000Z",
    "2026-10-25T13:15:00.000Z",
  ]);
  assert.equal(b.mode, "arm");
  assert.match(b.state_store, /^unreachable: upstash 400/);
});

test("FIX-1348 two hours without a row (8 ticks dark) → missed_ticks 8, with the banked buckets", async () => {
  const now = at("2026-10-25T13:45:28.228Z");
  const { fake, inserts } = io(async () => new Date(now - 2 * 3_600_000 - TICK_MS).toISOString());
  const backfill = await landBreadcrumb(fake, now, { state: "ok" }, CARRY_1345);
  assert.ok(backfill && "missed_ticks" in backfill);
  assert.equal(backfill.missed_ticks, 8);
  assert.deepEqual(backfill.buckets, CARRY_1345.buckets);
  assert.deepEqual(inserts[0]!["backfill"], backfill);
});

test("FIX-1348 the newest-row read failing → backfill { error }, and the INSERT is still attempted", async () => {
  const { fake, inserts, order } = io(async () => { throw new Error("canceling statement due to statement timeout"); });
  const backfill = await landBreadcrumb(fake, at("2026-10-25T13:45:28.228Z"), { state: "ok" }, CARRY_1345);
  assert.deepEqual(backfill, { error: "canceling statement due to statement timeout" });
  assert.deepEqual(order, ["read", "insert"]);
  assert.deepEqual(inserts[0]!["backfill"], { error: "canceling statement due to statement timeout" });
});

test("FIX-1348 no newest row at all (the first tick ever) is not a gap", async () => {
  const { fake, inserts } = io(async () => null);
  assert.equal(await landBreadcrumb(fake, at("2026-10-25T13:45:28.228Z"), {}, CARRY_1345), null);
  assert.equal(inserts[0]!["backfill"], null);
});

test("FIX-1348 a late tick is late, not missing — inside the grace and up to the half period", () => {
  const now = at("2026-10-25T13:45:28.228Z");
  for (const minutes of [15, 16.9, 17.5, 22]) {
    assert.equal(decideBackfill(now - minutes * 60_000, now, CARRY_1345), null, `${minutes} min`);
  }
  const one = decideBackfill(now - 30 * 60_000 + 400, now, CARRY_1345);
  assert.ok(one && "missed_ticks" in one);
  assert.equal(one.missed_ticks, 1, "one tick missing, cron jitter either way");
});
