// FIX-569: client fetch wrapper for the new-account first-writes challenge.
//
// On a 403 `{ code: "challenge_required" }` from a content-CREATE route, mint a
// Cloudflare Turnstile token (managed/invisible — usually solved in ~1s with no
// user interaction) and replay the request ONCE with `captchaToken` merged into
// the JSON body. This matches the design's "surface on the challenged write and
// resubmit" without a visible modal (managed mode).
//
// FIX-576: when Cloudflare ESCALATES to an interactive challenge, an off-screen
// widget can't be solved — the invisible attempt would just time out and the
// write would silently fail. So on escalation we hand off to a visible modal
// (via the challenge-controller bridge) and replay once the user solves it.
//
// Cost shape: ESTABLISHED accounts never receive the 403, so they never load the
// Turnstile script — only brand-new accounts pay the cost, only on a write. When
// NEXT_PUBLIC_TURNSTILE_SITE_KEY is absent the wrapper is a plain fetch (the
// server-side gate is inert too without TURNSTILE_SECRET_KEY), so dev/preview
// envs without keys behave exactly as before.
//
// Use for content-CREATE writes only: POST /api/comments, POST|PUT /api/positions,
// POST /api/statements. Do NOT use for ratings / statement-votes / flags — those
// are not challenged (too noisy, by design).

import { requestInteractiveChallenge } from "./challenge-controller";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id?: string) => void;
}
function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (turnstileApi()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("turnstile load failed")));
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("turnstile load failed"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// Outcome of the invisible (off-screen) attempt.
//   token !== null            → auto-solved, replay straight away (the common case)
//   token === null, escalated → Cloudflare wants interaction; hand off to the modal
//   token === null, !escalated→ genuine error / no key → fail-safe, surface the 403
interface InvisibleResult {
  token: string | null;
  escalated: boolean;
}

// Render a transient off-screen managed widget and resolve with its token.
// `escalated` is set when Cloudflare signals it needs user interaction
// (`before-interactive-callback`), when the interactive challenge can't be
// solved off-screen in time (`timeout-callback`), or when our own watchdog
// fires — all symptoms of an escalation an invisible widget can't satisfy, so
// the caller should retry via the visible modal. A genuine `error-callback`,
// missing key, or script-load failure leaves `escalated` false (fail-safe).
async function getInvisibleToken(timeoutMs = 8000): Promise<InvisibleResult> {
  if (!SITE_KEY || typeof window === "undefined") return { token: null, escalated: false };
  try {
    await loadScript();
  } catch {
    return { token: null, escalated: false };
  }
  const api = turnstileApi();
  if (!api) return { token: null, escalated: false };

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-9999px";
  container.style.bottom = "0";
  document.body.appendChild(container);

  return new Promise<InvisibleResult>((resolve) => {
    let settled = false;
    let widgetId: string | undefined;
    const finish = (result: InvisibleResult) => {
      if (settled) return;
      settled = true;
      try {
        if (widgetId) api.remove(widgetId);
      } catch {
        /* widget already gone */
      }
      container.remove();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ token: null, escalated: true }), timeoutMs);
    try {
      widgetId = api.render(container, {
        sitekey: SITE_KEY,
        appearance: "interaction-only",
        callback: (token: string) => {
          clearTimeout(timer);
          finish({ token, escalated: false });
        },
        "before-interactive-callback": () => {
          clearTimeout(timer);
          finish({ token: null, escalated: true });
        },
        "timeout-callback": () => {
          clearTimeout(timer);
          finish({ token: null, escalated: true });
        },
        "error-callback": () => {
          clearTimeout(timer);
          finish({ token: null, escalated: false });
        },
      });
    } catch {
      clearTimeout(timer);
      finish({ token: null, escalated: false });
    }
  });
}

/**
 * fetch() that transparently satisfies the FIX-569 first-writes challenge. On a
 * 403 `challenge_required` it mints a Turnstile token and replays the request
 * once with `captchaToken` merged into the JSON body. Every other response
 * (including a 403 with a different/absent code) passes straight through.
 */
export async function challengedFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 403) return res;

  let code: string | undefined;
  try {
    code = (await res.clone().json())?.code;
  } catch {
    return res;
  }
  if (code !== "challenge_required") return res;

  // Try the invisible fast path first; on escalation, fall back to the modal.
  const invisible = await getInvisibleToken();
  let token = invisible.token;
  if (!token && invisible.escalated) {
    token = await requestInteractiveChallenge();
  }
  if (!token) return res; // no key / dismissed / failed → surface the original 403

  let body: Record<string, unknown> = {};
  if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = {};
    }
  }
  return fetch(url, { ...init, body: JSON.stringify({ ...body, captchaToken: token }) });
}
