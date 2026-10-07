/**
 * FIX-1285 / FIX-1286 — the restart decision, replayed against the real
 * front-door series.
 *
 * The replays drive the same path the route does, tick by tick: the FIX-1130
 * verdict, then countDownTick, then decideRestart, then
 * planRestartStateCommands applied to a tiny in-memory store that honours
 * SET … EX/NX, INCR, EXPIRE and DEL. So the tick count, the spacing and the cap
 * are carried across ticks exactly as Upstash would carry them.
 *
 * THE PROBE IS A MODEL, AND THERE ARE TWO. The fixtures are `edge_logs` buckets;
 * nobody recorded what the direct probe answered at each tick, so the replays
 * run under both:
 *
 *   - "answers": the probe answers throughout. This is the MEASURED one: every
 *     10-06 DOWN page carried the Logs arm's subject, and every prod
 *     front_door_watch row since FIX-1285 reads probe_answered true.
 *   - "dark-in-red": the probe gets no answer at a tick whose own (still open)
 *     bucket is RED — cc-206's assumption, kept to show the restart no longer
 *     depends on it.
 *
 * Since FIX-1286 the two must agree: only a Logs-arm DOWN advances the hold, so
 * a probe-only DOWN (the dark model's earlier DOWN) pages but restarts nothing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  countDownTick,
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
  RESTART_HOLD_TICKS,
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
  type FrontDoorVerdict,
} from "./front-door-verdict";
import { HEALTHY, OUTAGE_0831, OUTAGE_1006, type FrontDoorRow } from "./__fixtures__/front-door-series";

const MIN = 60 * 1000;
const T = Date.parse("2026-10-06T17:47:28Z");

/** The 4th Logs-arm DOWN tick, probe dark, nothing recent, armed with a token. */
const BASE: RestartInput = {
  verdictState: "down",
  logsDown: true,
  downTicks: 4,
  probeAnswered: false,
  nowMs: T,
  downSinceMs: T - 45 * MIN,
  lastRestartMs: null,
  restartsLast24h: 0,
  mode: "arm",
  tokenPresent: true,
  health: "unknown",
};

describe("decideRestart — the table, one case per rule, in order", () => {
  test("the 4th consecutive Logs-arm DOWN tick → restart", () => {
    const d = decideRestart(BASE);
    assert.equal(d.action, "restart");
    assert.equal(d.downTicks, 4);
    assert.equal(d.downForMs, 45 * MIN);
  });

  test("FIX-1286: the 4th tick with the probe ANSWERED → still restart; the probe is reason-only", () => {
    const d = decideRestart({ ...BASE, probeAnswered: true });
    assert.equal(d.action, "restart");
    assert.match(d.reason, /probe answered/);
    assert.match(decideRestart(BASE).reason, /probe dark/);
  });

  test("not DOWN → none, whatever else is true (the caller clears the hold)", () => {
    for (const s of ["ok", "recovered", "corroborator_unavailable"] as const) {
      const d = decideRestart({ ...BASE, verdictState: s, logsDown: false, downTicks: 0 });
      assert.equal(d.action, "none", s);
      assert.equal(d.downForMs, null);
      assert.match(d.reason, new RegExp(`front door not DOWN \\(${s}\\)`));
    }
  });

  test("DOWN on the direct probe alone → none: only the Logs arm advances the hold", () => {
    const d = decideRestart({ ...BASE, logsDown: false, downTicks: 0 });
    assert.equal(d.action, "none");
    assert.match(d.reason, /direct probe alone/);
  });

  test("the state store did not answer → none: fail safe, never open", () => {
    const d = decideRestart({ ...BASE, stateError: "upstash: fetch failed" });
    assert.equal(d.action, "none");
    assert.match(d.reason, /state store unreachable/);
  });

  test("ticks 1-3 → none, and the reason counts them", () => {
    for (const n of [1, 2, 3]) {
      const d = decideRestart({ ...BASE, downTicks: n });
      assert.equal(d.action, "none", `tick ${n}`);
      assert.match(d.reason, new RegExp(`DOWN tick ${n} of ${RESTART_HOLD_TICKS} — the hold is 4 consecutive DOWN ticks`));
      assert.match(d.reason, /probe dark/);
    }
    assert.equal(RESTART_HOLD_TICKS, 4);
  });

  test("tick 4 with a restart in the last 60 min → skip; at exactly 60 the spacing is met", () => {
    const d = decideRestart({ ...BASE, downTicks: 8, lastRestartMs: T - 59 * MIN, restartsLast24h: 1 });
    assert.equal(d.action, "skip");
    assert.match(d.reason, /59 min ago/);
    assert.equal(decideRestart({ ...BASE, downTicks: 8, lastRestartMs: T - 60 * MIN, restartsLast24h: 1 }).action, "restart");
  });

  test("tick 4 with two restarts in 24 h → skip: a loop is worse than an outage", () => {
    const d = decideRestart({ ...BASE, lastRestartMs: T - 120 * MIN, restartsLast24h: 2 });
    assert.equal(d.action, "skip");
    assert.match(d.reason, /cap 2\/24 h/);
  });

  test("mode off → none; report → would_restart; arm without the token → would_restart, saying why", () => {
    assert.equal(decideRestart({ ...BASE, mode: "off" }).action, "none");
    assert.equal(decideRestart({ ...BASE, mode: "report" }).action, "would_restart");
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

  test("the order is the design: every skip outranks the mode", () => {
    assert.equal(decideRestart({ ...BASE, restartsLast24h: 2, lastRestartMs: T - 120 * MIN, mode: "off" }).action, "skip");
  });
});

describe("countDownTick — what advances the hold", () => {
  const verdict = (state: FrontDoorVerdict["state"], red: boolean[]): FrontDoorVerdict => ({
    state,
    red,
    isDownEdge: false,
    reason: "",
  });
  const stored = parseRestartState([null, null, null, null, "3"]);

  test("a Logs-arm DOWN counts, on top of the stored count", () => {
    assert.deepEqual(countDownTick(verdict("down", [false, false, true, true]), stored), { logsDown: true, downTicks: 4 });
    assert.deepEqual(countDownTick(verdict("down", [false, false, true, true]), null), { logsDown: true, downTicks: 1 });
  });

  test("a probe-only DOWN (newest two buckets not both RED) does not count and resets", () => {
    assert.deepEqual(countDownTick(verdict("down", [true, true, true, false]), stored), { logsDown: false, downTicks: 0 });
  });

  test("not DOWN resets", () => {
    assert.deepEqual(countDownTick(verdict("ok", [false, false, false, false]), stored), { logsDown: false, downTicks: 0 });
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

/** Upstash, in memory: MGET, SET … [EX s] [NX], INCR, EXPIRE, DEL. A key at its expiry instant is gone. */
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
      const [op, k] = c as [string, string];
      if (op === "DEL") {
        for (const key of c.slice(1)) this.m.delete(key);
      } else if (op === "INCR") {
        const cur = this.live(k, now);
        const exp = this.m.get(k)?.exp ?? null;
        this.m.set(k, { v: String(Number(cur ?? "0") + 1), exp });
      } else if (op === "EXPIRE") {
        const e = this.m.get(k);
        if (e) e.exp = now + Number(c[2]) * 1000;
      } else if (op === "SET") {
        const [, , v, ...opts] = c as [string, string, string, ...string[]];
        let exp: number | null = null;
        let nx = false;
        for (let i = 0; i < opts.length; i++) {
          if (opts[i] === "EX") exp = now + Number(opts[++i]) * 1000;
          else if (opts[i] === "NX") nx = true;
        }
        if (nx && this.live(k, now) !== null) continue;
        this.m.set(k, { v, exp });
      } else {
        throw new Error(`unexpected command ${op}`);
      }
    }
  }
}

type ProbeModel = "dark-in-red" | "answers";
type Tick = {
  at: string;
  state: string;
  action: RestartAction;
  reason: string;
  wouldEmail: boolean;
  /** down_ticks in the store AFTER this tick's writes (null = absent). */
  downTicksAfter: string | null;
};

const toBucket = (r: FrontDoorRow): FrontDoorBucket => ({ startMs: r[0], requests: r[1], n5xx: r[2], n52x: r[3] });
const hhmm = (iso: string) => iso.slice(11, 16);

function replayRestart(
  rows: FrontDoorRow[],
  opts: {
    probe: ProbeModel;
    mode?: RestartMode;
    tokenPresent?: boolean;
    /** Where inside the 15-min slot tick i fires, in ms past the boundary. Default :02. */
    offsetMs?: (i: number) => number;
  },
): { ticks: Tick[]; store: MemStore; lastNowMs: number } {
  const byStart = new Map<number, FrontDoorBucket>();
  for (const r of rows) byStart.set(r[0], toBucket(r));
  const starts = rows.map((r) => r[0]).sort((a, b) => a - b);
  const store = new MemStore();
  const ticks: Tick[] = [];
  const offset = opts.offsetMs ?? (() => 2 * MIN);
  let lastNowMs = 0;

  let i = 0;
  for (let t = starts[0]! + BUCKET_COUNT * BUCKET_MS; t <= starts[starts.length - 1]! + BUCKET_MS; t += BUCKET_MS, i++) {
    const nowMs = t + offset(i);
    lastNowMs = nowMs;
    const endBoundary = floorToBucket(nowMs);
    const present: FrontDoorBucket[] = [];
    for (let k = BUCKET_COUNT; k >= 1; k--) {
      const b = byStart.get(endBoundary - k * BUCKET_MS);
      if (b) present.push(b);
    }
    const open = byStart.get(endBoundary);
    const answered = opts.probe === "answers" || !(open && bucketIsRed(open));
    const probe: FrontDoorProbe = answered
      ? { answered: true, attempts: [{ status: 401, ms: 96 }] }
      : { answered: false, attempts: [1, 2, 3].map(() => ({ status: null, ms: 5000, error: "aborted" })) };
    const verdict = decideFrontDoorVerdict(alignBuckets(present, endBoundary), probe);

    const state = parseRestartState(store.mget(FRONT_DOOR_RESTART_MGET_KEYS, nowMs));
    const { logsDown, downTicks } = countDownTick(verdict, state);
    const decision = decideRestart({
      verdictState: verdict.state,
      logsDown,
      downTicks,
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
        logsDown,
        state,
        nowMs,
        restartIssued: decision.action === "restart",
        wouldRestartEmailed: wouldEmail,
      }),
      nowMs,
    );
    const [downTicksAfter] = store.mget([FRONT_DOOR_RESTART_KEYS.downTicks], nowMs);
    ticks.push({
      at: new Date(nowMs).toISOString(),
      state: verdict.state,
      action: decision.action,
      reason: decision.reason,
      wouldEmail,
      downTicksAfter: downTicksAfter ?? null,
    });
  }
  return { ticks, store, lastNowMs };
}

const actions = (ticks: Tick[], a: RestartAction) => ticks.filter((t) => t.action === a).map((t) => t.at);
const tickAt = (ticks: Tick[], hm: string) => ticks.find((t) => hhmm(t.at) === hm)!;
const BOTH = ["answers", "dark-in-red"] as const;

describe("replay — 2026-08-31", () => {
  for (const probe of BOTH) {
    test(`${probe}: the first restart is the 4th Logs-arm DOWN tick, 07:32 — then spacing, then the cap`, () => {
      const { ticks } = replayRestart(OUTAGE_0831, { probe });
      const restarts = actions(ticks, "restart");
      assert.equal(restarts[0], "2026-08-31T07:32:00.000Z");
      assert.ok(restarts.length <= 2, `got ${restarts.length}`);
      assert.deepEqual(restarts.map(hhmm), ["07:32", "08:32"]);
      // 77 min after the wedge went total at 06:15.
      assert.equal((Date.parse(restarts[0]!) - Date.parse("2026-08-31T06:15:00Z")) / MIN, 77);
    });
  }

  test("dark-in-red: the probe arm's earlier DOWN (06:17) pages but does not advance the hold", () => {
    const { ticks } = replayRestart(OUTAGE_0831, { probe: "dark-in-red" });
    const t = tickAt(ticks, "06:17");
    assert.equal(t.state, "down");
    assert.equal(t.action, "none");
    assert.match(t.reason, /direct probe alone/);
    assert.equal(t.downTicksAfter, null);
    assert.match(tickAt(ticks, "06:47").reason, /DOWN tick 1 of 4/);
  });

  test("report mode: would_restart from 07:32, and a WOULD FIRE email once per 6 h of outage", () => {
    const { ticks } = replayRestart(OUTAGE_0831, { probe: "answers", mode: "report" });
    assert.equal(actions(ticks, "restart").length, 0);
    assert.equal(actions(ticks, "would_restart")[0], "2026-08-31T07:32:00.000Z");
    assert.deepEqual(ticks.filter((t) => t.wouldEmail).map((t) => hhmm(t.at)), ["07:32", "13:32", "19:32"]);
  });

  test("the outage's keys are cleared on recovery; last_restart_at survives for the cap", () => {
    const { store, lastNowMs } = replayRestart(OUTAGE_0831, { probe: "answers" });
    const [down, last, , sent, n] = store.mget(FRONT_DOOR_RESTART_MGET_KEYS, lastNowMs);
    assert.deepEqual([down, sent, n], [null, null, null]);
    assert.equal(last, "2026-08-31T08:32:00.000Z");
  });
});

describe("replay — 2026-10-06", () => {
  for (const probe of BOTH) {
    test(`${probe}: the first restart is 17:47 (Logs-arm DOWN edge 17:02 + three ticks)`, () => {
      const { ticks } = replayRestart(OUTAGE_1006, { probe });
      assert.deepEqual(actions(ticks, "restart").map(hhmm), ["17:47", "18:47"]);
      // 77 min after the first RED quarter (16:30); the hand restart came 00:46.
      assert.equal((Date.parse(actions(ticks, "restart")[0]!) - Date.parse("2026-10-06T16:30:00Z")) / MIN, 77);
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

  for (const probe of BOTH) {
    test(`${probe}: 08-29 (the FIX-1125 self-clearing event) restarts NOTHING — 3 DOWN ticks, then not DOWN at 07:32`, () => {
      const { ticks } = replayRestart(byDay.get("2026-08-29")!, { probe });
      assert.equal(actions(ticks, "restart").length, 0);
      assert.equal(actions(ticks, "would_restart").length, 0);
      for (const [hm, n] of [["06:47", "1"], ["07:02", "2"], ["07:17", "3"]] as const) {
        assert.equal(tickAt(ticks, hm).downTicksAfter, n, hm);
      }
      const t732 = tickAt(ticks, "07:32");
      assert.notEqual(t732.state, "down");
      assert.equal(t732.downTicksAfter, null, "down_ticks is DEL'd on the first not-DOWN tick");
    });
  }

  test("the five other days, under both models: not one counted tick", () => {
    for (const [day, rows] of byDay) {
      if (day === "2026-08-29") continue;
      for (const probe of BOTH) {
        const { ticks } = replayRestart(rows, { probe });
        assert.ok(ticks.length > 80, day);
        assert.ok(ticks.every((t) => t.action === "none" && t.downTicksAfter === null), `${day} (${probe})`);
      }
    }
  });

  test("the 09-01 statement-timeout window (up to 100 % 5xx, at most 2 x 52x) restarts nothing", () => {
    const window = HEALTHY.filter(
      (r) => r[0] >= Date.parse("2026-09-01T11:00:00Z") && r[0] < Date.parse("2026-09-01T20:00:00Z"),
    );
    for (const probe of BOTH) {
      assert.ok(replayRestart(window, { probe }).ticks.every((t) => t.action === "none"));
    }
  });
});

describe("the jitter test — the counter cannot see the clock", () => {
  const restartSlots = (offsetMs: (i: number) => number) =>
    actions(replayRestart(OUTAGE_1006, { probe: "answers", offsetMs }).ticks, "restart").map((iso) =>
      new Date(floorToBucket(Date.parse(iso))).toISOString(),
    );

  test("ticks at :28.400, at :28.600, and with one tick 2 s late restart on the same ticks", () => {
    const early = restartSlots(() => 28_400);
    const late = restartSlots(() => 28_600);
    // The 3rd DOWN tick (17:32 slot, index of 17:30) fires 2 s late.
    const lateIdx = (Date.parse("2026-10-06T17:30:00Z") - Date.parse("2026-10-06T16:00:00Z")) / BUCKET_MS;
    const oneLate = restartSlots((i) => (i === lateIdx ? 30_600 : 28_400));
    assert.deepEqual(early, ["2026-10-06T17:45:00.000Z", "2026-10-06T18:45:00.000Z"]);
    assert.deepEqual(late, early);
    assert.deepEqual(oneLate, early);
  });
});

describe("planRestartStateCommands", () => {
  const K = FRONT_DOOR_RESTART_KEYS;
  const empty = parseRestartState([null, null, null, null, null]);
  const now = Date.parse("2026-10-06T17:02:28Z");

  test("a healthy tick on an empty store writes nothing — one MGET is the whole healthy cost", () => {
    assert.deepEqual(
      planRestartStateCommands({ logsDown: false, state: empty, nowMs: now, restartIssued: false, wouldRestartEmailed: false }),
      [],
    );
  });

  test("the first counted tick: INCR + EXPIRE 86400 + down_since SET NX", () => {
    assert.deepEqual(
      planRestartStateCommands({ logsDown: true, state: empty, nowMs: now, restartIssued: false, wouldRestartEmailed: false }),
      [
        ["INCR", K.downTicks],
        ["EXPIRE", K.downTicks, "86400"],
        ["SET", K.downSince, "2026-10-06T17:02:28.000Z", "EX", "86400", "NX"],
      ],
    );
  });

  test("a later counted tick: INCR only", () => {
    const st = parseRestartState(["2026-10-06T17:02:28.000Z", null, null, null, "2"]);
    assert.deepEqual(
      planRestartStateCommands({ logsDown: true, state: st, nowMs: now + 30 * MIN, restartIssued: false, wouldRestartEmailed: false }),
      [["INCR", K.downTicks]],
    );
  });

  test("a restart appends to the 24 h list, dropping instants older than the window", () => {
    const st = parseRestartState([
      "2026-10-06T16:00:00.000Z",
      "2026-10-06T15:00:00.000Z",
      JSON.stringify(["2026-10-05T10:00:00.000Z", "2026-10-06T15:00:00.000Z"]),
      null,
      "5",
    ]);
    const cmds = planRestartStateCommands({ logsDown: true, state: st, nowMs: now, restartIssued: true, wouldRestartEmailed: false });
    assert.deepEqual(cmds, [
      ["INCR", K.downTicks],
      ["SET", K.lastRestartAt, "2026-10-06T17:02:28.000Z", "EX", "86400"],
      ["SET", K.restarts, JSON.stringify(["2026-10-06T15:00:00.000Z", "2026-10-06T17:02:28.000Z"]), "EX", "86400"],
    ]);
    assert.equal(restartsWithin24h(st, now), 1);
  });

  test("the first not-counted tick after an outage deletes down_ticks, down_since and the WOULD FIRE key", () => {
    const st = parseRestartState(["2026-10-06T16:32:00.000Z", null, null, "2026-10-06T17:02:00.000Z", "3"]);
    assert.deepEqual(
      planRestartStateCommands({ logsDown: false, state: st, nowMs: now, restartIssued: false, wouldRestartEmailed: false }),
      [["DEL", K.downTicks, K.downSince, K.wouldRestartSent]],
    );
  });

  test("a value that does not parse reads as absent", () => {
    const st = parseRestartState(["not a date", 7, "{not json", "", "x"]);
    assert.deepEqual(st, { downSinceMs: null, lastRestartMs: null, restartsMs: [], wouldRestartSentMs: null, downTicks: null });
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
  test("read is ONE MGET of the five keys, in the order parseRestartState reads", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ result: ["2026-10-06T16:32:00.000Z", null, JSON.stringify(["2026-10-06T15:00:00.000Z"]), null, "3"] }),
    );
    const r = await readRestartState(CREDS, fetch);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://example.upstash.io");
    assert.equal(calls[0]!.auth, "Bearer tok");
    assert.deepEqual(calls[0]!.body, ["MGET", ...FRONT_DOOR_RESTART_MGET_KEYS]);
    assert.equal(FRONT_DOOR_RESTART_MGET_KEYS.length, 5);
    assert.ok(r.ok);
    assert.equal(r.ok && r.state.downSinceMs, Date.parse("2026-10-06T16:32:00Z"));
    assert.equal(r.ok && r.state.restartsMs.length, 1);
    assert.equal(r.ok && r.state.downTicks, 3);
  });

  test("a vendor error, a short reply or a dead network is ok:false — the caller fails safe", async () => {
    const vendor = await readRestartState(CREDS, fakeFetch(() => json({ error: "WRONGPASS invalid password" }, 401)).fetch);
    assert.equal(vendor.ok, false);
    assert.match(!vendor.ok ? vendor.error : "", /WRONGPASS/);
    const short = await readRestartState(CREDS, fakeFetch(() => json({ result: [null, null, null, null] })).fetch);
    assert.equal(short.ok, false);
    const dead = await readRestartState(CREDS, fakeFetch(() => Promise.reject(new Error("fetch failed"))).fetch);
    assert.equal(dead.ok, false);
  });

  test("write sends nothing for no commands, and pipelines the rest in one request", async () => {
    const none = fakeFetch(() => json([]));
    assert.deepEqual(await writeRestartState(CREDS, [], none.fetch), { ok: true, commands: 0 });
    assert.equal(none.calls.length, 0);

    const cmds = [["INCR", FRONT_DOOR_RESTART_KEYS.downTicks], ["EXPIRE", FRONT_DOOR_RESTART_KEYS.downTicks, "86400"]];
    const two = fakeFetch(() => json([{ result: 1 }, { result: 1 }]));
    assert.deepEqual(await writeRestartState(CREDS, cmds, two.fetch), { ok: true, commands: 2 });
    assert.equal(two.calls[0]!.url, "https://example.upstash.io/pipeline");
    assert.deepEqual(two.calls[0]!.body, cmds);
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
  const decision = {
    action: "restart" as const,
    reason: "DOWN tick 4 (since 17:02Z), probe answered — restarting; health unknown",
    downForMs: 45 * MIN,
    downTicks: 4,
  };
  const health = { health: "unknown" as const, detail: "health HTTP 403" };

  test("the subjects carry their tags and the tick count", () => {
    const issued = renderRestartEmail({ kind: "issued", decision, mode: "arm", nowMs: T, health, call: { ok: true, status: 200, detail: "{}", ms: 812 } });
    assert.match(issued.subject, /^\[Civitics\]\[FRONT DOOR RESTART ISSUED\] HTTP 200/);
    assert.match(issued.subject, /DOWN tick 4/);
    const failed = renderRestartEmail({ kind: "issued", decision, mode: "arm", nowMs: T, health, call: { ok: false, status: 401, detail: "", ms: 90 } });
    assert.match(failed.subject, /RESTART ISSUED\] FAILED — HTTP 401/);
    const would = renderRestartEmail({ kind: "would_fire", decision: { ...decision, action: "would_restart" }, mode: "report", nowMs: T, health });
    assert.match(would.subject, /^\[Civitics\]\[FRONT DOOR RESTART WOULD FIRE\] report mode/);
    assert.match(would.html, /Nothing was restarted/);
  });

  test("the DOWN email's line names the mode, the action and the reason", () => {
    assert.equal(
      restartLine({ action: "none", reason: "DOWN tick 2 of 4", downForMs: 15 * MIN, downTicks: 2 }, "arm"),
      "Auto-restart (FIX-1285, FRONT_DOOR_AUTO_RESTART=arm): none — DOWN tick 2 of 4",
    );
  });
});
