/**
 * FIX-1285 — the restart decision, replayed against the real front-door series.
 *
 * The replays drive the same path the route does, tick by tick: the FIX-1130
 * verdict, then decideRestart, then planRestartStateCommands applied to a tiny
 * in-memory store that honours SET … EX/NX and DEL. So `down_since`, the spacing
 * and the cap are carried across ticks exactly as Upstash would carry them.
 *
 * THE PROBE IS A MODEL, AND THERE ARE TWO. The fixtures are `edge_logs` buckets;
 * nobody recorded what the direct probe answered at each tick. The restart
 * fires only when the probe does NOT answer, so the replays run under both:
 *
 *   - "dark-in-red": the probe gets no answer at a tick whose own (still open)
 *     bucket is RED. This is the design's assumption.
 *   - "answers": the probe answers throughout. The 10-06 30-minute series shows
 *     ~2 non-5xx requests per half hour through the whole wedge — the
 *     watchdog's two ticks — and the DOWN pages arrived hourly, which is the
 *     Logs arm's cadence (the probe arm pages every tick). Both point here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decideRestart,
  parseRestartMode,
  parseRestartState,
  planRestartStateCommands,
  restartsWithin24h,
  shouldEmailWouldRestart,
  readRestartState,
  writeRestartState,
  readProjectHealth,
  issueProjectRestart,
  renderRestartEmail,
  restartLine,
  FRONT_DOOR_RESTART_KEYS,
  FRONT_DOOR_RESTART_MGET_KEYS,
  RESTART_HOLD_MS,
  type RestartAction,
  type RestartInput,
  type RestartMode,
} from "./front-door-restart";
import {
  alignBuckets,
  bucketIsRed,
  decideFrontDoorVerdict,
  floorToBucket,
  BUCKET_COUNT,
  BUCKET_MS,
  type FrontDoorBucket,
  type FrontDoorProbe,
} from "./front-door-verdict";
import { HEALTHY, OUTAGE_0831, OUTAGE_1006, type FrontDoorRow } from "./__fixtures__/front-door-series";

const MIN = 60 * 1000;
const T = Date.parse("2026-10-06T17:02:00Z");

const BASE: RestartInput = {
  verdictState: "down",
  probeAnswered: false,
  nowMs: T,
  downSinceMs: T - 31 * MIN,
  lastRestartMs: null,
  restartsLast24h: 0,
  mode: "arm",
  tokenPresent: true,
  health: "unknown",
};

describe("decideRestart — the table, one case per rule, in order", () => {
  test("held DOWN, probe dark, nothing recent, armed with a token → restart", () => {
    const d = decideRestart(BASE);
    assert.equal(d.action, "restart");
    assert.equal(d.downForMs, 31 * MIN);
  });

  test("not DOWN → none, whatever else is true (the caller clears down_since)", () => {
    for (const s of ["ok", "recovered", "corroborator_unavailable"] as const) {
      const d = decideRestart({ ...BASE, verdictState: s });
      assert.equal(d.action, "none", s);
      assert.equal(d.downForMs, null);
    }
  });

  test("the state store did not answer → none: fail safe, never open", () => {
    const d = decideRestart({ ...BASE, stateError: "upstash: fetch failed" });
    assert.equal(d.action, "none");
    assert.match(d.reason, /state store unreachable/);
  });

  test("the first DOWN tick → none (the caller sets down_since = now)", () => {
    const d = decideRestart({ ...BASE, downSinceMs: null });
    assert.equal(d.action, "none");
    assert.equal(d.downForMs, 0);
    assert.match(d.reason, /first DOWN tick/);
  });

  test("held under 30 min → none; at exactly 30 the hold is met", () => {
    const d = decideRestart({ ...BASE, downSinceMs: T - 29 * MIN });
    assert.equal(d.action, "none");
    assert.match(d.reason, /held 29 min, threshold 30/);
    assert.equal(decideRestart({ ...BASE, downSinceMs: T - RESTART_HOLD_MS }).action, "restart");
  });

  test("the direct probe answers → skip: the Logs half alone never restarts", () => {
    const d = decideRestart({ ...BASE, probeAnswered: true });
    assert.equal(d.action, "skip");
    assert.match(d.reason, /the direct probe answers/);
  });

  test("a restart in the last 60 min → skip; at exactly 60 the spacing is met", () => {
    const d = decideRestart({ ...BASE, lastRestartMs: T - 59 * MIN, restartsLast24h: 1 });
    assert.equal(d.action, "skip");
    assert.match(d.reason, /59 min ago/);
    assert.equal(decideRestart({ ...BASE, lastRestartMs: T - 60 * MIN, restartsLast24h: 1 }).action, "restart");
  });

  test("two restarts in 24 h → skip: a loop is worse than an outage", () => {
    const d = decideRestart({ ...BASE, lastRestartMs: T - 120 * MIN, restartsLast24h: 2 });
    assert.equal(d.action, "skip");
    assert.match(d.reason, /cap 2\/24 h/);
  });

  test("mode off → none", () => {
    assert.equal(decideRestart({ ...BASE, mode: "off" }).action, "none");
  });

  test("mode report → would_restart", () => {
    assert.equal(decideRestart({ ...BASE, mode: "report" }).action, "would_restart");
  });

  test("arm without the restart token → would_restart, and the reason says why", () => {
    const d = decideRestart({ ...BASE, tokenPresent: false });
    assert.equal(d.action, "would_restart");
    assert.match(d.reason, /SUPABASE_MANAGEMENT_RESTART_KEY/);
  });

  test("health is reported, never gated on", () => {
    for (const h of ["healthy", "unhealthy", "unknown"] as const) {
      const d = decideRestart({ ...BASE, health: h });
      assert.equal(d.action, "restart", h);
      assert.match(d.reason, new RegExp(`health ${h}`));
    }
  });

  test("the order is the design: the probe skip outranks the cap, and every skip outranks the mode", () => {
    const both = decideRestart({ ...BASE, probeAnswered: true, restartsLast24h: 2 });
    assert.match(both.reason, /the direct probe answers/);
    assert.equal(decideRestart({ ...BASE, probeAnswered: true, mode: "off" }).action, "skip");
  });
});

describe("parseRestartMode", () => {
  test("unset is report — arming is a deliberate act", () => {
    assert.deepEqual(parseRestartMode(undefined), { mode: "report", warning: null });
    assert.deepEqual(parseRestartMode(""), { mode: "report", warning: null });
  });
  test("the three values, case- and space-tolerant", () => {
    assert.equal(parseRestartMode("off").mode, "off");
    assert.equal(parseRestartMode(" ARM ").mode, "arm");
    assert.equal(parseRestartMode("report").mode, "report");
  });
  test("a typo reports, with a warning — it can never arm", () => {
    const m = parseRestartMode("armed");
    assert.equal(m.mode, "report");
    assert.match(m.warning ?? "", /not off\|report\|arm/);
  });
});

// ── The replay harness ──────────────────────────────────────────────────────

/** Upstash, in memory: MGET, SET … [EX s] [NX], DEL. A key at its expiry instant is gone. */
class MemStore {
  private m = new Map<string, { v: string; exp: number | null }>();
  private live(k: string, now: number): string | null {
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp !== null && now >= e.exp) {
      this.m.delete(k);
      return null;
    }
    return e.v;
  }
  mget(keys: readonly string[], now: number): Array<string | null> {
    return keys.map((k) => this.live(k, now));
  }
  apply(cmds: string[][], now: number): void {
    for (const c of cmds) {
      if (c[0] === "DEL") {
        for (const k of c.slice(1)) this.m.delete(k);
      } else if (c[0] === "SET") {
        const [, k, v, ...opts] = c as [string, string, string, ...string[]];
        let exp: number | null = null;
        let nx = false;
        for (let i = 0; i < opts.length; i++) {
          if (opts[i] === "EX") exp = now + Number(opts[++i]) * 1000;
          else if (opts[i] === "NX") nx = true;
        }
        if (nx && this.live(k, now) !== null) continue;
        this.m.set(k, { v, exp });
      } else {
        throw new Error(`unexpected command ${c[0]}`);
      }
    }
  }
}

type ProbeModel = "dark-in-red" | "answers";
type Tick = { at: string; state: string; action: RestartAction; reason: string; wouldEmail: boolean };

const toBucket = (r: FrontDoorRow): FrontDoorBucket => ({ startMs: r[0], requests: r[1], n5xx: r[2], n52x: r[3] });
const hhmm = (iso: string) => iso.slice(11, 16);

function replayRestart(
  rows: FrontDoorRow[],
  opts: { probe: ProbeModel; mode?: RestartMode; tokenPresent?: boolean },
): { ticks: Tick[]; store: MemStore; lastNowMs: number } {
  const byStart = new Map<number, FrontDoorBucket>();
  for (const r of rows) byStart.set(r[0], toBucket(r));
  const starts = rows.map((r) => r[0]).sort((a, b) => a - b);
  const store = new MemStore();
  const ticks: Tick[] = [];
  let lastNowMs = 0;

  // Ticks at :02 past each boundary, as in front-door-verdict.test.ts.
  for (let t = starts[0]! + BUCKET_COUNT * BUCKET_MS; t <= starts[starts.length - 1]! + BUCKET_MS; t += BUCKET_MS) {
    const nowMs = t + 2 * MIN;
    lastNowMs = nowMs;
    const endBoundary = floorToBucket(nowMs);
    const present: FrontDoorBucket[] = [];
    for (let i = BUCKET_COUNT; i >= 1; i--) {
      const b = byStart.get(endBoundary - i * BUCKET_MS);
      if (b) present.push(b);
    }
    const open = byStart.get(endBoundary);
    const answered = opts.probe === "answers" || !(open && bucketIsRed(open));
    const probe: FrontDoorProbe = answered
      ? { answered: true, attempts: [{ status: 401, ms: 96 }] }
      : { answered: false, attempts: [1, 2, 3].map(() => ({ status: null, ms: 5000, error: "aborted" })) };
    const verdict = decideFrontDoorVerdict(alignBuckets(present, endBoundary), probe);

    const state = parseRestartState(store.mget(FRONT_DOOR_RESTART_MGET_KEYS, nowMs));
    const decision = decideRestart({
      verdictState: verdict.state,
      probeAnswered: probe.answered,
      nowMs,
      downSinceMs: state.downSinceMs,
      lastRestartMs: state.lastRestartMs,
      restartsLast24h: restartsWithin24h(state, nowMs),
      mode: opts.mode ?? "arm",
      tokenPresent: opts.tokenPresent ?? true,
      health: "unknown",
    });
    const wouldEmail = shouldEmailWouldRestart(decision, state);
    store.apply(
      planRestartStateCommands({
        verdictState: verdict.state,
        state,
        nowMs,
        restartIssued: decision.action === "restart",
        wouldRestartEmailed: wouldEmail,
      }),
      nowMs,
    );
    ticks.push({ at: new Date(nowMs).toISOString(), state: verdict.state, action: decision.action, reason: decision.reason, wouldEmail });
  }
  return { ticks, store, lastNowMs };
}

const actions = (ticks: Tick[], a: RestartAction) => ticks.filter((t) => t.action === a).map((t) => t.at);
const firstDown = (ticks: Tick[]) => ticks.find((t) => t.state === "down")!.at;

describe("replay — 2026-08-31, probe dark through the wedge (the design's assumption)", () => {
  const { ticks, store, lastNowMs } = replayRestart(OUTAGE_0831, { probe: "dark-in-red" });

  test("the first DOWN tick is 06:17 — the probe arm, two minutes into the first RED bucket", () => {
    assert.equal(firstDown(ticks), "2026-08-31T06:17:00.000Z");
  });

  test("the first restart is 06:47: 30 min after the first DOWN tick, 32 min after the wedge went total", () => {
    const first = actions(ticks, "restart")[0]!;
    assert.equal(first, "2026-08-31T06:47:00.000Z");
    const lag = (Date.parse(first) - Date.parse("2026-08-31T06:15:00Z")) / MIN;
    assert.ok(lag >= 30 && lag <= 45, `onset to restart ${lag} min`);
  });

  test("exactly two restarts across the 17 h — 60 min apart, then the cap holds for the remaining ~15 h", () => {
    // The fixture is history: no restart happened, so the wedge runs on after
    // each one. D1's spacing (60 min) and cap (2 / 24 h) then allow exactly two.
    assert.deepEqual(actions(ticks, "restart").map(hhmm), ["06:47", "07:47"]);
    const later = ticks.filter((t) => t.state === "down" && Date.parse(t.at) > Date.parse("2026-08-31T07:47:00Z"));
    assert.ok(later.length > 50);
    assert.ok(later.every((t) => t.action === "skip"));
    assert.ok(later.some((t) => /cap 2\/24 h/.test(t.reason)));
  });

  test("the outage's keys are cleared on recovery; last_restart_at survives for the cap", () => {
    const [down, last, , sent] = store.mget(FRONT_DOOR_RESTART_MGET_KEYS, lastNowMs);
    assert.equal(down, null);
    assert.equal(sent, null);
    assert.equal(last, "2026-08-31T07:47:00.000Z");
  });

  test("report mode: would_restart from 06:47, and a WOULD FIRE email once per 6 h of outage", () => {
    const rep = replayRestart(OUTAGE_0831, { probe: "dark-in-red", mode: "report" }).ticks;
    assert.equal(actions(rep, "restart").length, 0);
    assert.equal(actions(rep, "would_restart")[0], "2026-08-31T06:47:00.000Z");
    assert.deepEqual(rep.filter((t) => t.wouldEmail).map((t) => hhmm(t.at)), ["06:47", "12:47", "18:47"]);
  });
});

describe("replay — 2026-10-06, probe dark through the wedge", () => {
  const { ticks } = replayRestart(OUTAGE_1006, { probe: "dark-in-red" });

  test("the first DOWN tick is 16:32 (the 16:00 half hour splits into two green quarters)", () => {
    assert.equal(firstDown(ticks), "2026-10-06T16:32:00.000Z");
  });

  test("the first restart lands between 16:45Z and 17:15Z", () => {
    const first = actions(ticks, "restart")[0]!;
    assert.equal(first, "2026-10-06T17:02:00.000Z");
    assert.ok(Date.parse(first) >= Date.parse("2026-10-06T16:45:00Z"));
    assert.ok(Date.parse(first) <= Date.parse("2026-10-06T17:15:00Z"));
  });

  test("two restarts, 60 min apart; the hand restart came 7 h 44 min after the first", () => {
    assert.deepEqual(actions(ticks, "restart").map(hhmm), ["17:02", "18:02"]);
  });
});

describe("replay — the probe answering through the wedge (what the 10-06 edge_logs suggest)", () => {
  for (const [name, rows, logsDown] of [
    ["2026-08-31", OUTAGE_0831, "2026-08-31T06:47:00.000Z"],
    ["2026-10-06", OUTAGE_1006, "2026-10-06T17:02:00.000Z"],
  ] as const) {
    test(`${name}: DOWN from the Logs arm at ${hhmm(logsDown)}, and NO restart — every held tick is a probe skip`, () => {
      const { ticks } = replayRestart(rows, { probe: "answers" });
      assert.equal(firstDown(ticks), logsDown);
      assert.equal(actions(ticks, "restart").length, 0);
      assert.equal(actions(ticks, "would_restart").length, 0);
      const skips = ticks.filter((t) => t.action === "skip");
      assert.ok(skips.length > 10);
      assert.ok(skips.every((t) => /the direct probe answers/.test(t.reason)));
    });
  }
});

describe("replay — six healthy days", () => {
  const byDay = new Map<string, FrontDoorRow[]>();
  for (const r of HEALTHY) {
    const d = new Date(r[0]).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }

  test("the five truly healthy days: no restart, no would_restart, not even a DOWN tick", () => {
    for (const [day, rows] of byDay) {
      if (day === "2026-08-29") continue;
      for (const probe of ["dark-in-red", "answers"] as const) {
        const { ticks } = replayRestart(rows, { probe });
        assert.ok(ticks.length > 80, day);
        assert.ok(ticks.every((t) => t.action === "none"), `${day} (${probe})`);
      }
    }
  });

  test("the 09-01 statement-timeout window (up to 100 % 5xx, at most 2 x 52x) restarts nothing", () => {
    const window = HEALTHY.filter(
      (r) => r[0] >= Date.parse("2026-09-01T11:00:00Z") && r[0] < Date.parse("2026-09-01T20:00:00Z"),
    );
    const { ticks } = replayRestart(window, { probe: "dark-in-red" });
    assert.ok(ticks.every((t) => t.action === "none"));
  });

  test("08-29 — the FIX-1125 event (RED 06:15-07:00, cleared on its own) — restarts once at 06:47 if the probe was dark", () => {
    // Not a false positive of the detector: it is a real 60-minute total-52x
    // outage. But it cleared by itself 28 minutes after this restart would have
    // fired, so the 30-minute hold does not filter it. Pinned so the arming
    // decision sees it.
    const rows = byDay.get("2026-08-29")!;
    assert.deepEqual(actions(replayRestart(rows, { probe: "dark-in-red" }).ticks, "restart").map(hhmm), ["06:47"]);
    assert.equal(actions(replayRestart(rows, { probe: "answers" }).ticks, "restart").length, 0);
  });
});

describe("planRestartStateCommands", () => {
  const K = FRONT_DOOR_RESTART_KEYS;
  const empty = parseRestartState([null, null, null, null]);
  const now = Date.parse("2026-10-06T17:02:00Z");

  test("a healthy tick on an empty store writes nothing — one MGET is the whole healthy cost", () => {
    assert.deepEqual(
      planRestartStateCommands({ verdictState: "ok", state: empty, nowMs: now, restartIssued: false, wouldRestartEmailed: false }),
      [],
    );
  });

  test("the first DOWN tick sets down_since with NX and a 24 h expiry", () => {
    assert.deepEqual(
      planRestartStateCommands({ verdictState: "down", state: empty, nowMs: now, restartIssued: false, wouldRestartEmailed: false }),
      [["SET", K.downSince, "2026-10-06T17:02:00.000Z", "EX", "86400", "NX"]],
    );
  });

  test("a restart appends to the 24 h list, dropping instants older than the window", () => {
    const st = parseRestartState([
      "2026-10-06T16:00:00.000Z",
      "2026-10-06T15:00:00.000Z",
      JSON.stringify(["2026-10-05T10:00:00.000Z", "2026-10-06T15:00:00.000Z"]),
      null,
    ]);
    const cmds = planRestartStateCommands({ verdictState: "down", state: st, nowMs: now, restartIssued: true, wouldRestartEmailed: false });
    assert.deepEqual(cmds, [
      ["SET", K.lastRestartAt, "2026-10-06T17:02:00.000Z", "EX", "86400"],
      ["SET", K.restarts, JSON.stringify(["2026-10-06T15:00:00.000Z", "2026-10-06T17:02:00.000Z"]), "EX", "86400"],
    ]);
    assert.equal(restartsWithin24h(st, now), 1);
  });

  test("the first non-DOWN tick after an outage deletes down_since and the WOULD FIRE key", () => {
    const st = parseRestartState(["2026-10-06T16:32:00.000Z", null, null, "2026-10-06T17:02:00.000Z"]);
    assert.deepEqual(
      planRestartStateCommands({ verdictState: "recovered", state: st, nowMs: now, restartIssued: false, wouldRestartEmailed: false }),
      [["DEL", K.downSince, K.wouldRestartSent]],
    );
  });

  test("a value that does not parse reads as absent", () => {
    const st = parseRestartState(["not a date", 7, "{not json", ""]);
    assert.deepEqual(st, { downSinceMs: null, lastRestartMs: null, restartsMs: [], wouldRestartSentMs: null });
  });
});

// ── I/O wrappers, with a fake fetch ─────────────────────────────────────────

type Call = { url: string; method: string; auth: string | null; body: unknown };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      auth: headers["Authorization"] ?? null,
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const CREDS = { url: "https://example.upstash.io/", token: "tok" };

describe("the Upstash wrapper", () => {
  test("read is ONE MGET of the four keys, in the order parseRestartState reads", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ result: ["2026-10-06T16:32:00.000Z", null, JSON.stringify(["2026-10-06T15:00:00.000Z"]), null] }),
    );
    const r = await readRestartState(CREDS, fetch);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://example.upstash.io");
    assert.equal(calls[0]!.auth, "Bearer tok");
    assert.deepEqual(calls[0]!.body, ["MGET", ...FRONT_DOOR_RESTART_MGET_KEYS]);
    assert.ok(r.ok);
    assert.equal(r.ok && r.state.downSinceMs, Date.parse("2026-10-06T16:32:00Z"));
    assert.equal(r.ok && r.state.restartsMs.length, 1);
  });

  test("a vendor error, a short reply or a dead network is ok:false — the caller fails safe", async () => {
    const vendor = await readRestartState(CREDS, fakeFetch(() => json({ error: "WRONGPASS invalid password" }, 401)).fetch);
    assert.equal(vendor.ok, false);
    assert.match(!vendor.ok ? vendor.error : "", /WRONGPASS/);
    const short = await readRestartState(CREDS, fakeFetch(() => json({ result: [null] })).fetch);
    assert.equal(short.ok, false);
    const dead = await readRestartState(CREDS, fakeFetch(() => Promise.reject(new Error("fetch failed"))).fetch);
    assert.equal(dead.ok, false);
  });

  test("write sends nothing for no commands, and pipelines the rest in one request", async () => {
    const none = fakeFetch(() => json([]));
    assert.deepEqual(await writeRestartState(CREDS, [], none.fetch), { ok: true, commands: 0 });
    assert.equal(none.calls.length, 0);

    const cmds = [["DEL", FRONT_DOOR_RESTART_KEYS.downSince, FRONT_DOOR_RESTART_KEYS.wouldRestartSent]];
    const one = fakeFetch(() => json([{ result: 1 }]));
    assert.deepEqual(await writeRestartState(CREDS, cmds, one.fetch), { ok: true, commands: 1 });
    assert.equal(one.calls[0]!.url, "https://example.upstash.io/pipeline");
    assert.deepEqual(one.calls[0]!.body, cmds);
  });

  test("a failed command inside the pipeline is reported by name", async () => {
    const r = await writeRestartState(CREDS, [["SET", "k", "v"]], fakeFetch(() => json([{ error: "OOM" }])).fetch);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /upstash SET: OOM/);
  });
});

describe("the Management API calls", () => {
  // Read 4 of cc-206, 2026-10-07 02:33:29Z, verbatim.
  const READ4 = [
    { name: "db", healthy: true, status: "ACTIVE_HEALTHY" },
    { name: "pooler", healthy: true, status: "ACTIVE_HEALTHY" },
    { name: "rest", healthy: true, status: "ACTIVE_HEALTHY", info: { db_schema: "public,graphql_public" } },
  ];

  test("health: read 4's body is healthy, and the GET names the three services", async () => {
    const { fetch, calls } = fakeFetch(() => json(READ4));
    const h = await readProjectHealth("sbp_read", fetch);
    assert.equal(h.health, "healthy");
    assert.equal(calls[0]!.url, "https://api.supabase.com/v1/projects/xsazcoxinpgttgquwvuf/health?services=db,pooler,rest");
    assert.equal(calls[0]!.auth, "Bearer sbp_read");
  });

  test("health: one unhealthy service is unhealthy; a 403 or a dead network is unknown", async () => {
    const sick = [{ ...READ4[0], healthy: false, status: "UNHEALTHY" }, READ4[1], READ4[2]];
    assert.equal((await readProjectHealth("t", fakeFetch(() => json(sick)).fetch)).health, "unhealthy");
    const forbidden = await readProjectHealth("t", fakeFetch(() => json({ message: "forbidden" }, 403)).fetch);
    assert.deepEqual(forbidden, { health: "unknown", detail: "health HTTP 403" });
    assert.equal((await readProjectHealth("t", fakeFetch(() => Promise.reject(new Error("x"))).fetch)).health, "unknown");
  });

  test("restart: a POST to the project's restart path with the restart token; 200 is ok", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const r = await issueProjectRestart("sbp_write", fetch);
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.supabase.com/v1/projects/xsazcoxinpgttgquwvuf/restart");
    assert.equal(calls[0]!.auth, "Bearer sbp_write");
  });

  test("restart: 429 is not ok; no response is status null", async () => {
    const limited = await issueProjectRestart("t", fakeFetch(() => json({ message: "slow down" }, 429)).fetch);
    assert.deepEqual([limited.ok, limited.status], [false, 429]);
    const dead = await issueProjectRestart("t", fakeFetch(() => Promise.reject(new Error("aborted"))).fetch);
    assert.deepEqual([dead.ok, dead.status], [false, null]);
  });
});

describe("what a reader sees", () => {
  const decision = { action: "restart" as const, reason: "DOWN 31 min, probe dark — restarting; health unknown", downForMs: 31 * MIN };
  const health = { health: "unknown" as const, detail: "health HTTP 403" };

  test("the three subjects carry their tags", () => {
    const issued = renderRestartEmail({ kind: "issued", decision, mode: "arm", nowMs: T, health, call: { ok: true, status: 200, detail: "{}", ms: 812 } });
    assert.match(issued.subject, /^\[Civitics\]\[FRONT DOOR RESTART ISSUED\] HTTP 200/);
    const failed = renderRestartEmail({ kind: "issued", decision, mode: "arm", nowMs: T, health, call: { ok: false, status: 401, detail: "", ms: 90 } });
    assert.match(failed.subject, /RESTART ISSUED\] FAILED — HTTP 401/);
    const would = renderRestartEmail({ kind: "would_fire", decision: { ...decision, action: "would_restart" }, mode: "report", nowMs: T, health });
    assert.match(would.subject, /^\[Civitics\]\[FRONT DOOR RESTART WOULD FIRE\] report mode/);
    assert.match(would.html, /Nothing was restarted/);
  });

  test("the DOWN email's line names the mode, the action and the reason", () => {
    assert.equal(
      restartLine({ action: "skip", reason: "the direct probe answers", downForMs: 0 }, "report"),
      "Auto-restart (FIX-1285, FRONT_DOOR_AUTO_RESTART=report): skip — the direct probe answers",
    );
  });
});
