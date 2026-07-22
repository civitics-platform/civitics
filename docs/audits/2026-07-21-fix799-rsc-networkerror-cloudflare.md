# FIX-799 — intermittent RSC-fetch NetworkError on www.civitics.com

**Date:** 2026-07-21 · **Status:** closed — CF-transient, accepted noise (durable fix is a Cloudflare dashboard action, documented below).

## Symptom (observed once, 2026-07-12)

> `Failed to fetch RSC payload for https://www.civitics.com/institutions/<id>.
> Falling back to browser navigation. TypeError: NetworkError`

Next.js degrades gracefully (hard navigation), so the UX cost is one full page
load, not breakage. Observed a single time, in FIX-795 post-deploy QA.

## Investigation (2026-07-21)

**Both hosts are fronted by Cloudflare and challenge scripted/automated requests:**

```
$ curl -sSI https://www.civitics.com/     →  HTTP/1.1 403 Forbidden
                                              Cf-Mitigated: challenge
                                              Server: cloudflare
$ curl -sSI https://civitics.com/         →  HTTP/1.1 403 Forbidden
                                              Cf-Mitigated: challenge
                                              Server: cloudflare
```

A real headless Chrome navigation to `https://www.civitics.com/` lands on the
Cloudflare interstitial (`document.title === "Just a moment..."`, 403) — CF
challenges even a real browser engine here.

**This confirms suspect (1) — Cloudflare challenge-on-fetch — as the mechanism.**
When Cloudflare decides to challenge a Next.js `fetch()`-issued RSC request
(intermittently, driven by the session's bot score / managed-challenge rules),
the fetch receives the 403 `Cf-Mitigated: challenge` HTML instead of the RSC
payload. The browser surfaces that as `TypeError: NetworkError`, and Next falls
back to a hard navigation — exactly the reported symptom.

**Suspect (2), canonicalization, is NOT the trigger:**

- `Cf-Mitigated: challenge` fires identically on **both** `www` and apex, so a
  `www → apex` redirect would not remove the RSC NetworkError — the apex host
  challenges the same way.
- The app itself has **no** `www → apex` (host) redirect: `middleware.ts` only
  carries the FIX-418 `/agencies/<uuid> → /institutions/<uuid>` 308, and
  `next.config.mjs` has no host redirect. Any canonicalization redirect, if it
  exists, lives at the Cloudflare/Vercel edge — and CF's challenge intercepts
  before the origin, so it can't be observed via curl or headless browser from
  here (flagged as a USER check below).

## Verdict

CF-transient, single occurrence, graceful fallback → **accepted noise.** Per the
bullet's own guidance ("if it recurs rarely and is CF-transient, document and
close as accepted noise"), and one observed instance ever, **no retry machinery**
is built and **no code change** is made. A `www → apex` middleware 308 is
deliberately NOT added: it would not fix the RSC error (apex challenges too), and
blindly adding a host redirect behind an unknown CF/Vercel edge rule risks a
double-redirect.

## USER actions (Craig — Cloudflare/Vercel dashboards, not reachable from a session)

1. **Confirm the specific event (optional):** Cloudflare → Security → Events,
   filter to `/institutions/*` around the 2026-07-12 QA timestamp; a
   `managed_challenge` / `challenge` mitigation on a request carrying RSC headers
   confirms this exact cause.
2. **Durable fix (recommended if it recurs):** add a Cloudflare WAF / bot-fight
   **Skip** rule for the app's own RSC requests so CF stops challenging them.
   Next's soft-navigation RSC fetches are identifiable by request headers —
   `RSC: 1` and `Next-Router-Prefetch` / `Next-Router-State-Tree` (and
   `Sec-Fetch-Dest: empty` with a same-site referer). Skipping managed-challenge
   for `RSC eq "1"` same-origin GETs removes the whole class without weakening
   bot protection on real navigations.
3. **SEO nicety (separate from this FIX):** decide/confirm a `www → apex` 308 at
   the Cloudflare (Bulk Redirect / Redirect Rule) or Vercel domain layer — the
   sitemap canonical is apex `civitics.com` and the app does no host redirect.
   This is a canonicalization tidy-up, **not** a fix for the RSC NetworkError.

**Closure:** `Closes: FIX-799`, `Verified[FIX-799]: closes-as-no-op`.
