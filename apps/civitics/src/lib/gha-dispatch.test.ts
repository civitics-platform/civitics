// FIX-1218 — the GHA dispatcher: allowlist, request shape, answer vocabulary.
//
// Every path is driven through a FAKE fetch. The route stamps whatever
// dispatchWorkflow returns, so these outcomes are exactly what lands in
// pipeline_state.gha_dispatch_<stem> — including the refusals, which are the
// whole reason the stamp exists (rule 167: a refusal must never be silent).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GHA_DISPATCH_WORKFLOWS,
  buildDispatchRequest,
  classifyDispatchResponse,
  dispatchLogLine,
  dispatchWorkflow,
  resolveDispatchTarget,
  runGhaDispatch,
  type DispatchTarget,
  type GhaDispatchDeps,
  type GhaDispatchRequest,
} from "./gha-dispatch";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: string, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 204 ? null : body, { status });
  }) as typeof fetch;
}

// The nightly's one door since FIX-1350 (cc-249): the dispatcher's request target.
const nightly = resolveDispatchTarget("nightly-request") as DispatchTarget;

describe("resolveDispatchTarget — the allowlist", () => {
  it("knows exactly the seven dispatched workflows (the nightly and the two congress.gov walkers through request targets), keyed by path segment", () => {
    assert.deepEqual([...GHA_DISPATCH_WORKFLOWS.keys()].sort(), [
      "audit",
      "bill-details-request",
      "crs-summaries-request",
      "irs990",
      "nightly-request",
      "platform-snapshot",
      "sync-canary-check",
      "vote-rolls-request",
    ]);
    for (const [key, t] of GHA_DISPATCH_WORKFLOWS) {
      // N2 (FIX-1336): a <stem>-request key is the dispatcher's door to that workflow and stamp.
      assert.equal(t.stem, key.replace(/-request$/, ""));
      assert.equal(t.gate === "request", key.endsWith("-request"), `${key}: gated exactly when it is a request target`);
      assert.equal(t.workflow, `${t.stem}.yml`, "the file is always <stem>.yml — never caller input");
    }
  });

  it("refuses anything else, including traversal and look-alikes", () => {
    for (const bad of [
      "../x",
      "../x.yml",
      "..%2Fx",
      "nightly/../audit",
      "weekly-integrity-audit",
      "audit.yml",
      "AUDIT",
      "irs990 ",
      "NIGHTLY",
      "nightly.yml",
      "nightly ",
      "",
      null,
      undefined,
    ]) {
      assert.equal(resolveDispatchTarget(bad), null, `${JSON.stringify(bad)} must be refused`);
    }
  });

  it("the nightly carries the slot rule and the trigger name; the others carry nothing", () => {
    assert.deepEqual(nightly.inputs, { slot_offset_hours: "3", dispatched_by: "dispatcher" });
    assert.equal(nightly.workflow, "nightly.yml");
    assert.equal(nightly.stem, "nightly", "stamps gha_dispatch_nightly, which canary-gha-dispatch reads");
    assert.equal(nightly.gate, "request");
    assert.deepEqual(resolveDispatchTarget("sync-canary-check")?.inputs, {});
    assert.deepEqual(resolveDispatchTarget("platform-snapshot")?.inputs, {});
    assert.equal(resolveDispatchTarget("sync-canary-check")?.gate, undefined, "ungated: fires on every call");
  });

  it("FIX-1424 (cc-292): irs990 and audit are plain dispatches — no inputs, no gate, the stem the file's", () => {
    for (const stem of ["irs990", "audit"]) {
      const t = resolveDispatchTarget(stem) as DispatchTarget;
      assert.deepEqual(t, { workflow: `${stem}.yml`, stem, inputs: {} }, stem);
    }
  });

  it("FIX-1455 (cc-318): crs-summaries-request is the CRS walker's request target with max_minutes 15; the Saturday slot is gone", () => {
    assert.deepEqual(resolveDispatchTarget("crs-summaries-request"), {
      workflow: "crs-summaries.yml", stem: "crs-summaries", inputs: { max_minutes: "15" }, gate: "request",
    });
    assert.equal(resolveDispatchTarget("crs-summaries"), null, "the plain target is outside the allowlist: the route's 400");
    const { url, init } = buildDispatchRequest(resolveDispatchTarget("crs-summaries-request") as DispatchTarget, "tok");
    assert.equal(url, "https://api.github.com/repos/civitics-platform/civitics/actions/workflows/crs-summaries.yml/dispatches");
    assert.equal(init.body, JSON.stringify({ ref: "main", inputs: { max_minutes: "15" } }), "exactly the input crs-summaries.yml declares");
  });

  it("FIX-1453 (cc-328): bill-details-request is the bill-details walker's request target — only all, max_minutes 15, both declared by bill-details.yml; no plain target", () => {
    const t = resolveDispatchTarget("bill-details-request") as DispatchTarget;
    assert.deepEqual(t, {
      workflow: "bill-details.yml", stem: "bill-details", inputs: { only: "all", max_minutes: "15" }, gate: "request",
    });
    assert.equal(resolveDispatchTarget("bill-details"), null, "there was never a plain target");
    const { url, init } = buildDispatchRequest(t, "tok");
    assert.equal(url, "https://api.github.com/repos/civitics-platform/civitics/actions/workflows/bill-details.yml/dispatches");
    assert.equal(init.body, JSON.stringify({ ref: "main", inputs: { only: "all", max_minutes: "15" } }));
    // The inputs are exactly what the workflow declares (a 422 otherwise), and "all" is one of only's choices.
    const yml = readFileSync(join(__dirname, "..", "..", "..", "..", ".github", "workflows", "bill-details.yml"), "utf8").replace(/\r\n/g, "\n");
    const block = /\n {2}workflow_dispatch:\n {4}inputs:\n([\s\S]*?)\n(?=\S)/.exec(yml)?.[1] ?? "";
    const declared = [...block.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]);
    assert.deepEqual(declared.sort(), Object.keys(t.inputs).sort());
    const only = /^ {6}only:\n([\s\S]*?)(?=^ {6}[a-z_]+:$)/m.exec(block)?.[1] ?? "";
    assert.match(only, /type: choice/);
    assert.deepEqual([...only.matchAll(/^ {10}- ([a-z]+)$/gm)].map((m) => m[1]), ["voted", "all"]);
  });

  it("FIX-1448 (cc-331): vote-rolls-request is the vote-rolls walker's request target — max_minutes 15, the one input vote-rolls.yml declares; no plain target", () => {
    const t = resolveDispatchTarget("vote-rolls-request") as DispatchTarget;
    assert.deepEqual(t, { workflow: "vote-rolls.yml", stem: "vote-rolls", inputs: { max_minutes: "15" }, gate: "request" });
    assert.equal(resolveDispatchTarget("vote-rolls"), null, "there was never a plain target");
    const { url, init } = buildDispatchRequest(t, "tok");
    assert.equal(url, "https://api.github.com/repos/civitics-platform/civitics/actions/workflows/vote-rolls.yml/dispatches");
    assert.equal(init.body, JSON.stringify({ ref: "main", inputs: { max_minutes: "15" } }));
    const yml = readFileSync(join(__dirname, "..", "..", "..", "..", ".github", "workflows", "vote-rolls.yml"), "utf8").replace(/\r\n/g, "\n");
    const block = /\n {2}workflow_dispatch:\n {4}inputs:\n([\s\S]*?)\n(?=\S)/.exec(yml)?.[1] ?? "";
    const declared = [...block.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]);
    assert.deepEqual(declared, ["max_minutes"]);
    assert.doesNotMatch(yml, /^ {2}schedule:/m, "the dispatcher is the only starter");
    const v = JSON.parse(readFileSync(join(__dirname, "..", "..", "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    assert.deepEqual(v.crons.filter((c) => c.path === "/api/cron/gha-dispatch/vote-rolls-request").map((c) => c.schedule), ["*/5 * * * *"]);
    assert.deepEqual(v.crons.filter((c) => c.path === "/api/cron/gha-dispatch/vote-rolls").map((c) => c.schedule), []);
  });

  it("FIX-1453 (cc-328): vercel.json polls bill-details-request every 5 minutes, as it polls crs-summaries-request", () => {
    const v = JSON.parse(readFileSync(join(__dirname, "..", "..", "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const at = (p: string) => v.crons.filter((c) => c.path === p).map((c) => c.schedule);
    assert.deepEqual(at("/api/cron/gha-dispatch/bill-details-request"), ["*/5 * * * *"]);
    assert.deepEqual(at("/api/cron/gha-dispatch/crs-summaries-request"), ["*/5 * * * *"]);
    assert.deepEqual(at("/api/cron/gha-dispatch/bill-details"), []);
    for (const c of v.crons) {
      const stem = /^\/api\/cron\/gha-dispatch\/([a-z0-9-]+)$/.exec(c.path)?.[1];
      if (stem) assert.ok(resolveDispatchTarget(stem), `${c.path}: every dispatch cron names an allowlisted target`);
    }
  });
});

// ---------------------------------------------------------------------------
// N2 (FIX-1336, cc-243) — runGhaDispatch: the gates, end to end
// ---------------------------------------------------------------------------

type Log = string[];
const NOW = Date.parse("2026-10-23T21:01:30Z");

function mockDeps(opts: {
  request?: GhaDispatchRequest | null;
  requestError?: string;
  status?: number;
}): { deps: GhaDispatchDeps; log: Log; fetches: Call[] } {
  const log: Log = [];
  const fetches: Call[] = [];
  const deps: GhaDispatchDeps = {
    readRequest: async (stem) => {
      log.push(`readRequest ${stem}`);
      return { value: opts.request ?? null, error: opts.requestError ?? null };
    },
    recordDispatch: async (p) => {
      log.push(`record ${String(p["workflow_stem"])} ${String(p["status"])}`);
      return { at: "2026-10-23T21:01:31Z", error: null };
    },
    consumeRequest: async (stem, outcome, http) => {
      log.push(`consume ${stem} ${outcome} ${String(http)}`);
      return { error: null };
    },
    dispatch: (t) => dispatchWorkflow(t, "tok", fakeFetch(opts.status ?? 204, "", fetches)),
    now: () => NOW,
  };
  return { deps, log, fetches };
}

describe("runGhaDispatch — nightly-request fires only on the dispatcher's stamp", () => {
  const req = resolveDispatchTarget("nightly-request") as DispatchTarget;

  it("a pending request → dispatched with dispatched_by=dispatcher, stamped, then consumed", async () => {
    const { deps, log, fetches } = mockDeps({ request: { job: "nightly", requested_at: "2026-10-23T21:01:00Z", consumed_at: null, reaped_at: null } });
    const r = await runGhaDispatch(req, deps);
    assert.equal(r.body["outcome"], "dispatched");
    assert.equal(r.body["ok"], true);
    assert.equal(fetches.length, 1);
    assert.match(String(fetches[0]?.init.body), /"dispatched_by":"dispatcher"/);
    assert.deepEqual(log, ["readRequest nightly", "record nightly dispatched", "consume nightly dispatched 204"]);
  });

  it("no request → no_request: no dispatch, NO record_gha_dispatch call, no consume", async () => {
    const { deps, log, fetches } = mockDeps({ request: null });
    const r = await runGhaDispatch(req, deps);
    assert.equal(r.body["outcome"], "no_request");
    assert.equal(fetches.length, 0);
    assert.deepEqual(log, ["readRequest nightly"]);
  });

  it("a consumed or reaped request → no_request", async () => {
    for (const request of [
      { requested_at: "2026-10-23T21:01:00Z", consumed_at: "2026-10-23T21:05:00Z" },
      { requested_at: "2026-10-23T21:01:00Z", consumed_at: null, reaped_at: "2026-10-23T21:21:00Z" },
    ]) {
      const { deps, log } = mockDeps({ request });
      assert.equal((await runGhaDispatch(req, deps)).body["outcome"], "no_request");
      assert.deepEqual(log, ["readRequest nightly"]);
    }
  });

  it("a request older than 2 h → stale_request, never fired", async () => {
    const { deps, fetches } = mockDeps({ request: { requested_at: "2026-10-23T18:00:00Z", consumed_at: null } });
    assert.equal((await runGhaDispatch(req, deps)).body["outcome"], "stale_request");
    assert.equal(fetches.length, 0);
  });

  it("an unreadable request → request_unreadable (an error line), no dispatch", async () => {
    const { deps, fetches } = mockDeps({ requestError: "timeout" });
    const r = await runGhaDispatch(req, deps);
    assert.equal(r.body["outcome"], "request_unreadable");
    assert.equal(r.error, true);
    assert.equal(fetches.length, 0);
  });

  it("a refused dispatch is still stamped AND consumed with its outcome (the reap reads it)", async () => {
    const { deps, log } = mockDeps({ request: { requested_at: "2026-10-23T21:01:00Z", consumed_at: null }, status: 401 });
    const r = await runGhaDispatch(req, deps);
    assert.equal(r.body["outcome"], "refused");
    assert.deepEqual(log.slice(1), ["record nightly refused", "consume nightly refused 401"]);
  });
});

describe("FIX-1350 (cc-249) — the legacy 0 21 nightly slot is gone", () => {
  it("`nightly` is outside the allowlist, so the route answers its 400 refusal and never reaches GitHub", () => {
    assert.equal(resolveDispatchTarget("nightly"), null);
    assert.equal(GHA_DISPATCH_WORKFLOWS.has("nightly"), false);
  });

  it("no target is registry-gated and none dispatches as vercel-cron", () => {
    for (const [key, t] of GHA_DISPATCH_WORKFLOWS) {
      assert.ok(t.gate === undefined || t.gate === "request", `${key}: gate ${String(t.gate)}`);
      assert.notEqual(t.inputs["dispatched_by"], "vercel-cron", key);
    }
  });

  it("an ungated target never reads a request", async () => {
    const { deps, log } = mockDeps({});
    await runGhaDispatch(resolveDispatchTarget("platform-snapshot") as DispatchTarget, deps);
    assert.deepEqual(log, ["record platform-snapshot dispatched"]);
  });
});

describe("runGhaDispatch — crs-summaries-request fires only on the dispatcher's stamp (FIX-1455, cc-318)", () => {
  const crs = resolveDispatchTarget("crs-summaries-request") as DispatchTarget;

  it("no pending request → no_request: the */5 poll fires nothing, stamps nothing, consumes nothing", async () => {
    for (const request of [null, { requested_at: "2026-10-23T21:01:00Z", consumed_at: "2026-10-23T21:05:00Z" }]) {
      const { deps, log, fetches } = mockDeps({ request });
      assert.equal((await runGhaDispatch(crs, deps)).body["outcome"], "no_request");
      assert.equal(fetches.length, 0);
      assert.deepEqual(log, ["readRequest crs-summaries"]);
    }
  });

  it("a pending request → dispatched with max_minutes 15, stamped gha_dispatch_crs-summaries, consumed", async () => {
    const { deps, log, fetches } = mockDeps({ request: { job: "crs-summaries", requested_at: "2026-10-23T21:00:00Z", consumed_at: null, reaped_at: null } });
    const r = await runGhaDispatch(crs, deps);
    assert.equal(r.body["outcome"], "dispatched");
    assert.equal(fetches.length, 1);
    assert.match(fetches[0]!.url, /\/workflows\/crs-summaries\.yml\/dispatches$/);
    assert.equal(fetches[0]!.init.body, JSON.stringify({ ref: "main", inputs: { max_minutes: "15" } }));
    assert.deepEqual(log, ["readRequest crs-summaries", "record crs-summaries dispatched", "consume crs-summaries dispatched 204"]);
  });
});

describe("runGhaDispatch — vote-rolls-request fires only on the dispatcher's stamp (FIX-1448, cc-331)", () => {
  const vr = resolveDispatchTarget("vote-rolls-request") as DispatchTarget;

  it("no pending request → no_request: fires nothing, stamps nothing, consumes nothing", async () => {
    for (const request of [null, { requested_at: "2026-10-23T21:01:00Z", consumed_at: "2026-10-23T21:05:00Z" }]) {
      const { deps, log, fetches } = mockDeps({ request });
      assert.equal((await runGhaDispatch(vr, deps)).body["outcome"], "no_request");
      assert.equal(fetches.length, 0);
      assert.deepEqual(log, ["readRequest vote-rolls"]);
    }
  });

  it("a pending request → dispatched with max_minutes 15, stamped gha_dispatch_vote-rolls, consumed", async () => {
    const { deps, log, fetches } = mockDeps({ request: { job: "vote-rolls", requested_at: "2026-10-23T21:00:00Z", consumed_at: null, reaped_at: null } });
    const r = await runGhaDispatch(vr, deps);
    assert.equal(r.body["outcome"], "dispatched");
    assert.equal(fetches.length, 1);
    assert.match(fetches[0]!.url, /\/workflows\/vote-rolls\.yml\/dispatches$/);
    assert.equal(fetches[0]!.init.body, JSON.stringify({ ref: "main", inputs: { max_minutes: "15" } }));
    assert.deepEqual(log, ["readRequest vote-rolls", "record vote-rolls dispatched", "consume vote-rolls dispatched 204"]);
  });
});

describe("runGhaDispatch — bill-details-request fires only on the dispatcher's stamp (FIX-1453, cc-328)", () => {
  const bd = resolveDispatchTarget("bill-details-request") as DispatchTarget;

  it("no pending request → no_request: fires nothing, stamps nothing, consumes nothing", async () => {
    for (const request of [null, { requested_at: "2026-10-23T21:01:00Z", consumed_at: "2026-10-23T21:05:00Z" }]) {
      const { deps, log, fetches } = mockDeps({ request });
      assert.equal((await runGhaDispatch(bd, deps)).body["outcome"], "no_request");
      assert.equal(fetches.length, 0);
      assert.deepEqual(log, ["readRequest bill-details"]);
    }
  });

  it("a pending request → dispatched with only all and max_minutes 15, stamped gha_dispatch_bill-details, consumed", async () => {
    const { deps, log, fetches } = mockDeps({ request: { job: "bill-details", requested_at: "2026-10-23T21:00:00Z", consumed_at: null, reaped_at: null } });
    const r = await runGhaDispatch(bd, deps);
    assert.equal(r.body["outcome"], "dispatched");
    assert.equal(fetches.length, 1);
    assert.match(fetches[0]!.url, /\/workflows\/bill-details\.yml\/dispatches$/);
    assert.equal(fetches[0]!.init.body, JSON.stringify({ ref: "main", inputs: { only: "all", max_minutes: "15" } }));
    assert.deepEqual(log, ["readRequest bill-details", "record bill-details dispatched", "consume bill-details dispatched 204"]);
  });
});

describe("buildDispatchRequest", () => {
  it("POSTs ref=main + the inputs to this repo's dispatches endpoint, no-store, bearer token", () => {
    const { url, init } = buildDispatchRequest(nightly, "tok");
    assert.equal(url, "https://api.github.com/repos/civitics-platform/civitics/actions/workflows/nightly.yml/dispatches");
    assert.equal(init.method, "POST");
    assert.equal(init.cache, "no-store");
    const h = init.headers as Record<string, string>;
    assert.equal(h["Authorization"], "Bearer tok");
    assert.equal(h["Accept"], "application/vnd.github+json");
    assert.equal(h["X-GitHub-Api-Version"], "2022-11-28");
    assert.deepEqual(JSON.parse(init.body as string), {
      ref: "main",
      inputs: { slot_offset_hours: "3", dispatched_by: "dispatcher" },
    });
  });
});

describe("dispatchWorkflow — every outcome the route will stamp", () => {
  it("204 (the historical answer) → dispatched, no run id", async () => {
    const calls: Call[] = [];
    const o = await dispatchWorkflow(nightly, "tok", fakeFetch(204, "", calls));
    assert.equal(o.status, "dispatched");
    assert.equal(o.http_status, 204);
    assert.equal(o.run_id, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init.cache, "no-store", "the fetch that actually went out must be no-store");
  });

  it("200 with workflow_run_id (the documented answer today) → dispatched, run id kept", async () => {
    const o = await dispatchWorkflow(
      nightly,
      "tok",
      fakeFetch(200, JSON.stringify({ workflow_run_id: 987654321, run_url: "x", html_url: "https://github.com/r/1" })),
    );
    assert.equal(o.status, "dispatched");
    assert.equal(o.run_id, 987654321);
    assert.equal(o.detail, "https://github.com/r/1");
  });

  it("401 (expired PAT) → refused, WITH the status and GitHub's message", async () => {
    const o = await dispatchWorkflow(nightly, "tok", fakeFetch(401, JSON.stringify({ message: "Bad credentials" })));
    assert.deepEqual(
      { status: o.status, http: o.http_status, detail: o.detail },
      { status: "refused", http: 401, detail: "Bad credentials" },
    );
  });

  it("403 / 404 / 422 → refused", async () => {
    for (const s of [403, 404, 422]) {
      const o = await dispatchWorkflow(nightly, "tok", fakeFetch(s, JSON.stringify({ message: `m${s}` })));
      assert.equal(o.status, "refused", `${s}`);
      assert.equal(o.detail, `m${s}`);
    }
  });

  it("5xx → error; a non-JSON body is carried as text", async () => {
    const o = await dispatchWorkflow(nightly, "tok", fakeFetch(502, "<html>bad gateway</html>"));
    assert.equal(o.status, "error");
    assert.equal(o.http_status, 502);
    assert.equal(o.detail, "<html>bad gateway</html>");
  });

  it("no token → refused without any network call", async () => {
    const calls: Call[] = [];
    for (const tok of [undefined, "", "   "]) {
      const o = await dispatchWorkflow(nightly, tok, fakeFetch(204, "", calls));
      assert.equal(o.status, "refused");
      assert.match(o.detail ?? "", /GITHUB_DISPATCH_TOKEN is not set/);
    }
    assert.equal(calls.length, 0);
  });

  it("a network error → error, never a throw", async () => {
    const boom = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const o = await dispatchWorkflow(nightly, "tok", boom);
    assert.equal(o.status, "error");
    assert.equal(o.http_status, null);
    assert.equal(o.detail, "fetch failed");
  });

  it("a hung GitHub → error at the timeout", async () => {
    // A real hung fetch holds a socket open, and that handle is what keeps the
    // event loop alive until the abort fires. AbortSignal.timeout's own timer is
    // UNREF'D, so a fake with no handle lets Node exit the loop first: on Linux
    // Node 20 (CI run 35948861696) that failed this case and every test after it
    // as "Promise resolution is still pending". The interval stands in for the socket.
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const socket = setInterval(() => {}, 1_000);
        init?.signal?.addEventListener("abort", () => {
          clearInterval(socket);
          reject(init.signal!.reason);
        });
      })) as unknown as typeof fetch;
    const o = await dispatchWorkflow(nightly, "tok", hang, 50);
    assert.equal(o.status, "error");
    assert.match(o.detail ?? "", /no answer from GitHub within 50 ms/);
  });
});

describe("classifyDispatchResponse + dispatchLogLine", () => {
  it("an empty non-2xx body still says something", () => {
    assert.deepEqual(classifyDispatchResponse(503, ""), { status: "error", run_id: null, detail: "HTTP 503" });
  });

  it("the log line names the workflow, status, http, DB clock and wall", () => {
    const line = dispatchLogLine(
      nightly,
      { status: "refused", http_status: 401, run_id: null, detail: "Bad credentials", elapsed_ms: 41 },
      "2026-09-24T21:00:01Z",
    );
    assert.equal(
      line,
      '[cron/gha-dispatch] workflow=nightly.yml status=refused http=401 at=2026-09-24T21:00:01Z elapsed_ms=41 detail="Bad credentials"',
    );
  });
});
