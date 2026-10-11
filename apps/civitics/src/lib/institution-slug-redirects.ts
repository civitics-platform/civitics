// FIX-1283 — /institutions/<slug> answers a true 308 to /institutions/<uuid>.
//
// The page resolves governing_bodies.slug → id itself and calls
// permanentRedirect(), but institutions/[id]/loading.tsx puts it under
// Suspense, so the redirect degrades to a 200 with a meta refresh (the
// FIX-418/433/439 root cause). middleware.ts asks this resolver first.
//
// It is the FIX-1278 resolver (official-redirects.ts) over a different list:
// one PostgREST read per isolate per hour, the same TTLs, timeout and one
// in-flight load, and it FAILS OPEN — a miss or a failed load returns null and
// the request falls through to the page, whose slug branch is unchanged. So an
// unknown slug is still the page's 200-not-found, exactly as before.
//
// Slugs match EXACTLY, as the page's `.eq("slug", id)` does — no case folding.
// governing_bodies held 622 slugged rows on prod at landing (cc-221), under
// ROW_CAP; the resolver logs when a read reaches the cap.

import { createRedirectResolver, type RedirectResolver, type RedirectResolverOptions, type RedirectSource } from "./official-redirects";

export const INSTITUTION_SLUGS: RedirectSource = {
  name: "institution-slugs",
  query: "governing_bodies?select=id,slug&slug=not.is.null",
  from: "slug",
  to: "id",
  foldCase: false,
};

export function createInstitutionSlugResolver(opts: Omit<RedirectResolverOptions, "source">): RedirectResolver {
  return createRedirectResolver({ ...opts, source: INSTITUTION_SLUGS });
}
