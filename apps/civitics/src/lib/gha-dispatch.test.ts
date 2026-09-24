// FIX-1218 — the GHA dispatcher: allowlist, request shape, answer vocabulary.
//
// Every path is driven through a FAKE fetch. The route stamps whatever
// dispatchWorkflow returns, so these outcomes are exactly what lands in
// pipeline_state.gha_dispatch_<stem> — including the refusals, which are the
// whole reason the stamp exists (rule 167: a refusal must never be silent).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GHA_DISPATCH_WORKFLOWS,
  buildDispatchRequest,
  classifyDispatchResponse,
  dispatchLogLine,
  dispatchWorkflow,
  resolveDispatchTarget,
  type DispatchTarget,
} from "./gha-dispatch";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: string, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 204 ? null : body, { status });
  }) as typeof fetch;
}

const nightly = resolveDispatchTarget("nightly") as DispatchTarget;

describe("resolveDispatchTarget — the allowlist", () => {
  it("knows exactly the three dispatched workflows, keyed by stem", () => {
    assert.deepEqual([...GHA_DISPATCH_WORKFLOWS.keys()].sort(), [
      "nightly",
      "platform-snapshot",
      "sync-canary-check",
    ]);
    for (const [stem, t] of GHA_DISPATCH_WORKFLOWS) {
      assert.equal(t.stem, stem);
      assert.equal(t.workflow, `${stem}.yml`, "the file is always <stem>.yml — never caller input");
    }
  });

  it("refuses anything else, including traversal and look-alikes", () => {
    for (const bad of [
      "../x",
      "../x.yml",
      "..%2Fx",
      "nightly/../audit",
      "audit",
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
    assert.deepEqual(nightly.inputs, { slot_offset_hours: "3", dispatched_by: "vercel-cron" });
    assert.equal(nightly.workflow, "nightly.yml");
    assert.deepEqual(resolveDispatchTarget("sync-canary-check")?.inputs, {});
    assert.deepEqual(resolveDispatchTarget("platform-snapshot")?.inputs, {});
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
      inputs: { slot_offset_hours: "3", dispatched_by: "vercel-cron" },
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
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
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
