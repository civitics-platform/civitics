# FIX-818 — /graph React #418/#422 hydration errors: verification & closure

**Date:** 2026-07-21 · **Status:** closed — verified no longer reproducing (recognized).

## What FIX-818 tracked

React minified errors **#418** (hydration text-content mismatch) and **#422**
(hydration failed — server/client render divergence) reported firing on *every*
`/graph` load on prod, observed both pre- and post-G4 deploy (c95af65) — so it
pre-dated the G4 wave (FIX-811–815) and was not a G4 regression. Non-fatal
(React recovers by client-re-rendering the mismatched subtree) but noisy.

## Verification performed (2026-07-21)

Three independent reproductions, all **clean** (no #418/#422, no exceptions):

1. **Live prod, anon, fresh browser profile** — headless Chrome + raw CDP against
   `https://civitics-civitics.vercel.app/graph`, `Network.setCacheDisabled`, fresh
   tab, 10s post-navigation capture. Landed on `/graph` (title "Connection Graph |
   Civitics"), **no** React hydration errors. Only console error: a `401` on
   `/api/graph/my-representatives` — expected when signed out (the code sets the
   "YOU" affordance card on 401). No main-frame redirect (vercel.app serves the
   app directly).
2. **Local production build** (`next build` + `next start`), fresh profile — clean.
3. **Local production build, populated localStorage** — seeded non-default panel
   widths (`civitics-graph-panel-width-left/right`), a `civitics_presets` saved
   view, and the you-card key, then hard-reloaded — still clean.

## Why the anon/fresh test is representative

`app/graph/page.tsx` is `export const dynamic = "force-static"`: the HTML is
prerendered once at build and served identically to every visitor. Hydration
compares that static HTML against the client's *first* render, both of which are
auth- and localStorage-independent — all dynamic reads in the graph shell are in
`useEffect` / event handlers, not initial render (verified by inspection):

- `useGraphView()` initializes to `DEFAULT_GRAPH_VIEW` (no localStorage/URL read
  at init).
- `GraphPage` reads localStorage (panel widths, you-card), `window.matchMedia`,
  `window.location` only inside `useEffect`; `new Date()` / `Math.random()` only
  in event handlers (create-group id, CSV export) and the screenshot panel (not
  rendered on load).
- `GhostGraph` uses fully static node/edge positions.

So a signed-in session or populated localStorage cannot introduce a *hydration*
mismatch that the anon/fresh test misses — the auth/state-dependent content loads
via post-hydration effects, which cannot cause #418/#422.

## Most plausible interim resolution

Between FIX-818's observation and now, the `/graph` shell changed. The strongest
structural candidate is **FIX-846** (FooterGate) — a "Graph Polish P1" fix that
landed *after* FIX-818 and stopped `<Footer />` (which computes
`const year = new Date().getFullYear()`, [Footer.tsx](../../apps/civitics/app/components/Footer.tsx))
rendering on `/graph`. The exact fixing commit is not pinned with certainty (the
graph shell also saw the G5 and P1/P2 waves), and Footer is a Server Component so
the precise mismatch mechanism is unconfirmed — but the observable outcome is
that `/graph` now hydrates cleanly on prod.

## Residual

- Not tested: a signed-in prod session (can't/shouldn't mint prod auth from a
  sweep) — but see "representative" above for why that cannot change the hydration
  result on a force-static page.
- If #418/#422 ever recurs on `/graph`, reopen with the CDP capture recipe above.

**Closure:** `Closes: FIX-818`, `Verified[FIX-818]: closes-as-recognized`.
