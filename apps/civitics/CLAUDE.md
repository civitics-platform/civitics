# apps/civitics/CLAUDE.md

The Civitics app: Next.js App Router, built from `apps/civitics/app/`. Tone and
mission: `docs/ONBOARDING.md`. The pre-haircut file (user tiers, pricing, the
institutional API, the Phase 2–5 plans) is
`docs/archive/claude-md-apps-civitics-2026-10-24.md`.

---

## Data Rules

- **Never ship placeholder data** — real data or empty state, never fake
- **Always show empty state** — blank page is acceptable; fake data is not
- **Never add "Coming Soon" placeholders** without real content to back them up
- Loading skeletons always — sudden graph appearance is jarring
- Error boundaries always — graceful degradation on data failure

## Page Conventions

The build traps (`force-dynamic` beside `createAdminClient()`, the
`generateStaticParams` rules) are root `CLAUDE.md` §App traps →
`docs/OPERATIONS.md` §Build Failing on Vercel.

## Request-path queries MUST use withDbTimeout

**Every PostgREST read on a page-render path is wrapped in `withDbTimeout`**
(`@/lib/supabase-check`), at **3 s** on the request path (the default is 5 s):

```ts
const { data } = await withDbTimeout(
  supabase.from("officials").select("id,full_name").eq("id", id),
  3000,
  "officials:detail",      // greppable route:purpose label
);
// data can now be null — the call site MUST degrade gracefully (data ?? [],
// data?.foo, if (!data) notFound()). Never .map/.length a timeout-null; never
// throw on it. Inside Promise.all([...]) wrap EACH element individually.
```

`pnpm check:render-timeouts` (a blocking CI step) fails an unwrapped read under
`apps/civitics/app/**`; api routes, client components, `generateStaticParams`
and the metadata routes are excluded. It also fails a `revalidate` page that
does not call `assertRenderNotDegraded()` (FIX-1227). The escape hatch is a
`// db-timeout-exempt: <reason>` comment on the read line or the line above;
keep it rare. Why it is a cost defense: playbook B4 (FIX-638, FIX-639).

## Hydration Safety

Never nest `<a>`, `<button>` or `<input>` inside a `<Link>`: a clickable card is
the stretched-link pattern, overlay ABOVE the card body (FIX-1086) —
`packages/ui/CLAUDE.md` §Hydration. Never read `new Date()`, `Math.random()` or a
browser API during render — `docs/OPERATIONS.md` §Hydration Errors.
