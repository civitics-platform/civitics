# apps/civitics/CLAUDE.md

## Purpose
The Civitics civic governance app. "Wikipedia meets Bloomberg Terminal for democracy."
Structured civic data, legislative tracking, public comment submission, connection graph,
maps, and AI-powered accountability tools.

---

## Tone and Design Philosophy

**Serious civic infrastructure — not social media.**

- Closer to a court of record than Twitter
- Dense information display is a feature, not a bug — users came here to learn
- Bloomberg Terminal feel: data-rich, fast, trustworthy
- Never feel like a "politics tab" — no engagement bait, no outrage optimization
- Must never be conflated with the social app in UX or tone

---

## Active App Directory — CRITICAL

```
apps/civitics/app/       ← ACTIVE (Next.js builds this)
apps/civitics/src/app/   ← INACTIVE (silently ignored — stale duplicate)
```

**ALWAYS edit files in `apps/civitics/app/`**
Changes to `src/app/` are silently ignored at build time and will never appear on the live site.

---

## Data Rules

- **Never ship placeholder data** — real data or empty state, never fake
- **Always show empty state** — blank page is acceptable; fake data is not
- **Never add "Coming Soon" placeholders** without real content to back them up
- Loading skeletons always — sudden graph appearance is jarring
- Error boundaries always — graceful degradation on data failure

---

## Page Conventions

- Server Components for data fetching (default in Next.js App Router)
- Client Components for interactivity (`"use client"`)
- Every route/page that calls `createAdminClient()` must have: `export const dynamic = "force-dynamic";`
- `generateStaticParams`: use `createClient()` with publishable key only — never `createAdminClient()`
  (secret key unavailable at Vercel build time)

---

## Request-path queries MUST use withDbTimeout

**Every PostgREST read on a page-render path must be wrapped in `withDbTimeout`**
(`@/lib/supabase-check`). This is a COST defense, not just correctness: Vercel
bills provisioned fluid-compute memory for the *entire* time a function is
blocked on I/O. An unwrapped `await supabase.from(...).select(...)` against a
slow or degraded DB makes the render hang and accrue GB-hours while it waits —
and it's the only defense against a low-and-slow crawl that evades the IP rate
limiters. `withDbTimeout` races the query against a timeout (default 5s; prefer
**3s** on the request path) and returns `{ data: null, error }` instead of
hanging, so a degraded DB yields a fast degraded render.

```ts
import { withDbTimeout } from "@/lib/supabase-check";

const { data } = await withDbTimeout(
  supabase.from("officials").select("id,full_name").eq("id", id),
  3000,
  "officials:detail",      // greppable route:purpose label
);
// data can now be null — the call site MUST degrade gracefully (data ?? [],
// data?.foo, if (!data) notFound()). Never .map/.length a timeout-null; never
// throw on it. Inside Promise.all([...]) wrap EACH element individually.
```

**Enforced by CI.** `pnpm check:render-timeouts` (`scripts/check-render-timeouts.mjs`,
blocking step in `.github/workflows/tests.yml`) fails when a render-path read
under `apps/civitics/app/**` isn't wrapped. It excludes api routes, client
components, `generateStaticParams`, and build-time metadata routes
(`sitemap.ts`/`robots.ts`/`manifest.ts` — those carry their own `Promise.race`
timeout). Detection is lexical; the documented escape hatch for the rare
legitimate case (e.g. a builder defined on one line and wrapped on the next, or
a genuinely build-time-only path) is a `// db-timeout-exempt: <reason>` comment
on the read line or the line above. Keep exemptions rare and justified.

---

## Hydration Safety

React hydration errors mean the server-rendered HTML doesn't match what the client renders.
They are silent in dev builds but break production. Always check for these before shipping.

### The three common traps

**1. Interactive elements nested inside `<Link>` / `<a>`**

`<Link>` renders as `<a>`. Putting `<a>`, `<button>`, or `<input>` inside it is invalid HTML.
Browsers auto-correct the DOM, which diverges from what React expects → hydration mismatch.

Bad:
```tsx
<Link href="/proposals/123">
  <div>
    <button>Share</button>   {/* button inside a — invalid */}
    <a href="...">Submit</a> {/* a inside a — invalid */}
  </div>
</Link>
```

Fix — use the **stretched link** pattern instead:
```tsx
<div className="relative group ...">
  {/* Overlay covers the entire card and sits ABOVE the static content */}
  <Link href="/proposals/123" className="absolute inset-0 z-10" aria-label={title} />

  {/* Content wrapper: positioned, but NO z-index of its own */}
  <div className="relative">
    <h3>...</h3>                       {/* card body — clicks hit the overlay */}

    {/* Real controls are raised back above the overlay */}
    <div className="relative z-20">
      <button>Share</button>
      <a href="...">Submit</a>
    </div>
  </div>
</div>
```

**The z-order trap (FIX-1086): the overlay must be ABOVE the card body, not
below it.** Writing the overlay at `z-0` under a `z-10` content wrapper — the
shape this doc used to recommend — makes the whole card body dead: the click
lands on the content div, which is not a descendant of the anchor, so nothing
navigates even though `cursor-pointer` says otherwise. Two rules keep it
working:

- The overlay's z-index must be **higher** than the content's.
- The content wrapper must **not** carry a z-index (`relative` alone). A
  z-index there creates a stacking context, and then nothing inside it can be
  raised above the overlay — the buttons go dead instead of the body.

Check it, don't eyeball it: `document.elementFromPoint(x, y)` at a card title's
centre must resolve to something with an enclosing `<a>` (`.closest("a")`).
`CommentPeriodCard` in `@civitics/ui` is the reference implementation.

`group-hover:` still works — put `group` on the outer `<div>`, not the `<Link>`.

---

**2. `new Date()` / `Date.now()` / `Math.random()` called during render**

Server renders at request time; client re-renders at hydration time. If the value changes
between the two, the output differs → hydration mismatch. Conditional branches (`isOpen`,
`isExpired`) are especially dangerous because they affect DOM structure, not just text.

Bad:
```tsx
const open = new Date(endDate) > new Date(); // different on server vs client
return open ? <CommentBadge /> : null;       // structural mismatch
```

Fix: pass a pre-computed boolean from the Server Component, or use `suppressHydrationWarning`
only for leaf text nodes that genuinely can't be made deterministic.

---

**3. Browser APIs (`window`, `navigator`, `localStorage`) accessed during render**

Server Components have no `window`. If the access is in a Server Component it throws; if it's
in a Client Component it runs on the server during SSR and returns `undefined`, then differs
on the client → hydration mismatch.

Fix: always guard with `useEffect` (runs client-only, after hydration):
```tsx
const [url, setUrl] = useState<string | null>(null);
useEffect(() => { setUrl(window.location.href); }, []);
```

---

### Quick checklist before shipping a new component

- [ ] No `<Link>` or `<a>` wrapping another `<a>`, `<button>`, `<input>`, or `<select>`
- [ ] No `new Date()` / `Math.random()` called at render time in a component that conditionally renders structure
- [ ] No `window` / `navigator` / `localStorage` read outside a `useEffect`

---

## Build Rule

**`pnpm build` must pass locally before every push.**
Vercel uses strict TypeScript. A passing build locally = no Vercel deploy failure.
Never push without running the build first.

---

## User Access Tiers

### Free (ad-supported, genuinely powerful — covers 90% of citizen needs)
- Full data access: agencies, officials, courts, proposals, votes, spending, campaign finance
- Cached AI summaries (unlimited)
- 3 personalized AI queries/day, 1 comment draft/day
- Official comment submission (always unlimited — constitutional right)
- Connection graph (up to 3 hops), Vote pattern analyzer, Donor impact calculator
- Bill tracker (20 bills), Timeline builder

### Contributing Member ($5/mo or 500 credits)
- Unlimited AI queries (50/day fair use), unlimited comment drafts
- Ad-free, API access (1k calls/mo), data export, advanced visualization
- Unlimited saved searches, unlimited connection graph depth

### Investigator ($20/mo)
- Multi-hop connection graph, bulk downloads, webhooks, custom feeds
- Collaborative workspaces, full document archives

### Organization ($99/mo)
- 10 team accounts, API (50k calls/mo), white-label reports
- Coalition tools, petition management

---

## Institutional API

The same data that powers the public platform via versioned REST API for institutional customers.
Primary path to financial sustainability.

| Tier | Price | Calls/mo | Target |
|------|-------|----------|--------|
| Researcher | $49/mo | 10k | Academics, independent journalists |
| Nonprofit | $149/mo | 50k | Watchdog orgs, journalism nonprofits |
| Professional | $499/mo | 250k | Law firms, policy organizations |
| Enterprise | Custom | Unlimited | Major media, research institutions |

**API Design Rules:**
- Versioned from day one: `/api/v1/` never breaks
- `updated_after` filter on every collection endpoint
- `GET /v1/connections/path` — the investigation superpower
- Revenue projection: 10 Researcher + 5 Nonprofit + 3 Professional + 1 Enterprise = ~$4,700/mo (covers all infrastructure)

---

## Candidate Empowerment (Phase 5)

The platform lowers the barrier to entry for genuine public service.

**"Should I Run?" 5-step explorer:**
1. Honest Reality Check — not a pep talk; unvarnished statistics
2. Viability Assessment — district data, vulnerability scores, fundraising path
3. Authentic Platform Generation — AI drafts platform from user's actual public contributions
4. Private Support Snapshot — estimated early supporters before any announcement
5. The Decision — three equal paths: Run / Support a candidate / Lead differently

Platform candidate budget: ~$730k vs. traditional ~$10M

**Candidate verification levels:** Identity Verified → Transparency Pledge → Community Verified → Platform Champion

---

## Contribution Portal (Community Development, Phase 2–3)

Community members contribute to platform development using AI assistance:
- **Type A (~20 min):** Data tasks, config files, translations — zero code required
- **Type B (~60–90 min):** Feature tasks — sandboxed Claude session, auto-tested
- **Type C:** Core infrastructure — vetted contributors only

Contributors earn 50 civic credits per completed task.
Type A costs platform ~$0.20 API; worth $200–500 in equivalent development.

---

## Global Deployment Architecture

The `jurisdictions` table hierarchy makes global deployment a configuration change, not a rebuild:
- `jurisdictions` is hierarchical: global → country → state → county → city
- Every entity belongs to a jurisdiction node
- Each country gets a configuration file: data sources, government structure, terminology

**Country priority:** UK/Canada/Australia (Tier 1) → Germany/France/Japan (Tier 2) → Brazil/South Africa/Mexico (Tier 3)

**Censorship resistance for Tier 3:** Tor hidden service, ENS domain, IPFS, offline PWA.

