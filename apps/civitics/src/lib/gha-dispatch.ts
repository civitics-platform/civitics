/**
 * FIX-1218 — fire a GitHub Actions `workflow_dispatch` at the slot.
 *
 * WHY. GitHub starts a scheduled workflow when it gets to it, not when the cron
 * says: nightly.yml's `0 21` has started 1.6–2.7 h late on every one of the 14
 * nights since 09-10, platform-snapshot's every-10-minute cron ran 13 times in 48 h, and
 * sync-canary-check's `0 5` lands 3.7–5.3 h late (cc-150 read 2). A Vercel cron
 * is on time to the minute, so it POSTs the dispatch and the run starts at the
 * slot. The `schedule:` triggers stay as the fallback.
 *
 * The route (app/api/cron/gha-dispatch) owns auth and the stamp; this module
 * owns everything that can be tested without a network: the allowlist, the
 * request, and what each GitHub answer means.
 *
 * ── THE ANSWER VOCABULARY ────────────────────────────────────────────────────
 *
 * GitHub's REST docs (read 2026-09-24) now document the endpoint as answering
 * `200` with `{workflow_run_id, run_url, html_url}`; it answered `204 No
 * Content` historically, and the cc-150 prompt was written against that. Both
 * are `dispatched` — the run id is kept when it comes back and is simply absent
 * when it does not. `401` (bad or EXPIRED token — fine-grained PATs expire),
 * `403` (token lacks Actions: write), `404` (wrong repo or file, or a token not
 * scoped to this repo) and `422` (an input the workflow does not declare, or a
 * choice value it does not list) are `refused`: GitHub heard the call and said
 * no, which is a configuration problem and is stamped as one. Anything else — a
 * 5xx, a timeout, a network error — is `error`.
 */

/** The repository every dispatch targets. Never taken from the request. */
export const GHA_REPO = "civitics-platform/civitics";

/** How long the route waits on GitHub before calling it an error. */
export const GHA_DISPATCH_TIMEOUT_MS = 10_000;

export interface DispatchTarget {
  /** The workflow file, as the API path takes it. */
  workflow: string;
  /** `gha_dispatch_<stem>` in pipeline_state. */
  stem: string;
  /** Exactly what the workflow's `workflow_dispatch.inputs` declares. */
  inputs: Record<string, string>;
}

/**
 * THE ALLOWLIST, keyed by STEM — the route's `[workflow]` path segment, e.g.
 * `/api/cron/gha-dispatch/nightly`. A literal: the segment is only ever used
 * as a lookup key into this map, so no caller-supplied string reaches the
 * GitHub URL. Adding a workflow is an edit here AND a cron in vercel.json.
 *
 * A path segment rather than the `?workflow=<file>` the cc-150 prompt named:
 * Vercel documents one cron per dynamic-route segment
 * (docs/cron-jobs/manage-cron-jobs, "Cron jobs with dynamic routes") and says
 * nothing about a query string in `path`. The stem also carries no dot, so no
 * middleware or static-file rule keyed on an extension can intercept it.
 *
 * nightly gets `slot_offset_hours: "3"` so a dispatch at the 21:00 slot names
 * the NEXT UTC day, exactly as a schedule event does (FIX-1163), and
 * `dispatched_by: "vercel-cron"` so its preflight de-duplicates against the
 * late scheduled fallback. The other two declare no inputs and read none.
 */
export const GHA_DISPATCH_WORKFLOWS: ReadonlyMap<string, DispatchTarget> = new Map<string, DispatchTarget>([
  [
    "nightly",
    {
      workflow: "nightly.yml",
      stem: "nightly",
      inputs: { slot_offset_hours: "3", dispatched_by: "vercel-cron" },
    },
  ],
  ["sync-canary-check", { workflow: "sync-canary-check.yml", stem: "sync-canary-check", inputs: {} }],
  ["platform-snapshot", { workflow: "platform-snapshot.yml", stem: "platform-snapshot", inputs: {} }],
]);

/** The allowlist lookup. `null` for anything not in it, including `../x`. */
export function resolveDispatchTarget(stem: string | null | undefined): DispatchTarget | null {
  if (stem === null || stem === undefined) return null;
  return GHA_DISPATCH_WORKFLOWS.get(stem) ?? null;
}

export type DispatchStatus = "dispatched" | "refused" | "error";

export interface DispatchOutcome {
  status: DispatchStatus;
  http_status: number | null;
  run_id: number | null;
  /** GitHub's message on a refusal/error; the run URL on a success when given. */
  detail: string | null;
  elapsed_ms: number;
}

const REFUSED_STATUSES = new Set([401, 403, 404, 422]);

/**
 * What one GitHub response means. Pure: `bodyText` is whatever the response
 * carried ("" for a 204).
 */
export function classifyDispatchResponse(
  httpStatus: number,
  bodyText: string,
): Pick<DispatchOutcome, "status" | "run_id" | "detail"> {
  let body: Record<string, unknown> | null = null;
  if (bodyText.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  if (httpStatus === 200 || httpStatus === 204) {
    const runId = typeof body?.["workflow_run_id"] === "number" ? (body["workflow_run_id"] as number) : null;
    const url = typeof body?.["html_url"] === "string" ? (body["html_url"] as string) : null;
    return { status: "dispatched", run_id: runId, detail: url };
  }
  const message =
    typeof body?.["message"] === "string"
      ? (body["message"] as string)
      : bodyText.trim() === ""
        ? `HTTP ${httpStatus}`
        : bodyText.trim().slice(0, 300);
  return {
    status: REFUSED_STATUSES.has(httpStatus) ? "refused" : "error",
    run_id: null,
    detail: message,
  };
}

/** The request, built once so the tests can assert its exact shape. */
export function buildDispatchRequest(
  target: DispatchTarget,
  token: string,
): { url: string; init: RequestInit } {
  return {
    url: `https://api.github.com/repos/${GHA_REPO}/actions/workflows/${encodeURIComponent(target.workflow)}/dispatches`,
    init: {
      method: "POST",
      // rule 171 / FIX-1208: every fetch in a cron route is no-store. A POST is
      // not Data-Cached today, but "today" is the assumption FIX-1208 paid for.
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "civitics-gha-dispatch",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs: target.inputs }),
    },
  };
}

/**
 * Dispatch one workflow. Never throws: every path — no token, a refusal, a
 * timeout, a network error — comes back as an outcome for the route to stamp.
 */
export async function dispatchWorkflow(
  target: DispatchTarget,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = GHA_DISPATCH_TIMEOUT_MS,
): Promise<DispatchOutcome> {
  const t0 = Date.now();
  if (token === undefined || token.trim() === "") {
    return {
      status: "refused",
      http_status: null,
      run_id: null,
      detail: "GITHUB_DISPATCH_TOKEN is not set in this deployment's environment",
      elapsed_ms: 0,
    };
  }
  const { url, init } = buildDispatchRequest(target, token.trim());
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => "");
    return { ...classifyDispatchResponse(res.status, text), http_status: res.status, elapsed_ms: Date.now() - t0 };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      status: "error",
      http_status: null,
      run_id: null,
      detail:
        name === "TimeoutError" || name === "AbortError"
          ? `no answer from GitHub within ${timeoutMs} ms`
          : err instanceof Error
            ? err.message
            : String(err),
      elapsed_ms: Date.now() - t0,
    };
  }
}

/** The one log line per call, in the cron-watchdog route's shape. */
export function dispatchLogLine(target: DispatchTarget, o: DispatchOutcome, dbAt: string | null): string {
  return (
    `[cron/gha-dispatch] workflow=${target.workflow} status=${o.status} http=${o.http_status ?? "none"}` +
    (o.run_id === null ? "" : ` run_id=${o.run_id}`) +
    ` at=${dbAt ?? "unstamped"} elapsed_ms=${o.elapsed_ms}` +
    (o.status === "dispatched" || o.detail === null ? "" : ` detail=${JSON.stringify(o.detail)}`)
  );
}
