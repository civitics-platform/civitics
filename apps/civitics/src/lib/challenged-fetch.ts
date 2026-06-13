// FIX-569: client fetch wrapper for the new-account first-writes challenge.
//
// On a 403 `{ code: "challenge_required" }` from a content-CREATE route, mint a
// Cloudflare Turnstile token (managed/invisible — usually solved in ~1s with no
// user interaction) and replay the request ONCE with `captchaToken` merged into
// the JSON body. This matches the design's "surface on the challenged write and
// resubmit" without a visible modal (managed mode).
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

// Render a transient off-screen managed widget and resolve with its token.
// Resolves null on no-site-key / error / timeout so the caller surfaces the
// original 403 rather than hanging.
async function getTurnstileToken(timeoutMs = 8000): Promise<string | null> {
  if (!SITE_KEY || typeof window === "undefined") return null;
  try {
    await loadScript();
  } catch {
    return null;
  }
  const api = turnstileApi();
  if (!api) return null;

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-9999px";
  container.style.bottom = "0";
  document.body.appendChild(container);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    let widgetId: string | undefined;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      try {
        if (widgetId) api.remove(widgetId);
      } catch {
        /* widget already gone */
      }
      container.remove();
      resolve(token);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      widgetId = api.render(container, {
        sitekey: SITE_KEY,
        appearance: "interaction-only",
        callback: (token: string) => {
          clearTimeout(timer);
          finish(token);
        },
        "error-callback": () => {
          clearTimeout(timer);
          finish(null);
        },
        "timeout-callback": () => {
          clearTimeout(timer);
          finish(null);
        },
      });
    } catch {
      clearTimeout(timer);
      finish(null);
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

  const token = await getTurnstileToken();
  if (!token) return res; // no key / failed → surface the original 403

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
