// scripts/lib/no-store-routes.mjs — FIX-1214
//
// THE predicate for "a GET Route Handler whose admin-client reads can be
// answered from Next's Data Cache". One implementation: the app's source-
// anchored test (apps/civitics/src/lib/no-store-routes.test.ts) and the CI
// guard (scripts/check-no-store-routes.mjs) both call it, so the list they
// check is derived the same way and cannot drift.
//
// ── The mechanism (next@14.2.35, read from its own source — rule 171) ─────────
//
// server/lib/patch-fetch.js decides each fetch's cache posture when it is made:
//
//   const autoNoCache = (hasUnCacheableHeader || isUnCacheableMethod)
//                       && staticGenerationStore.revalidate === 0;
//   …
//   } else if (autoNoCache) { revalidate = 0; cacheReason = "auto no cache"; }
//   …
//   } else { cacheReason = "auto cache"; revalidate = … ? false : …; }
//
// supabase-js always sends `Authorization: Bearer <key>` (fetchWithAuth), so
// every admin-client read is "auto no cache" IF the store's revalidate is 0 by
// then — and "auto cache" with revalidate false (a one-year Data Cache entry,
// keyed on URL + body + headers) if it is not. In a GET Route Handler the store
// starts at `userland.revalidate ?? false` (app-route/module.js); `dynamic =
// "force-dynamic"` sets only `forceDynamic` and hands the handler the RAW
// request, so nothing lowers it. What does lower it to 0, for every LATER fetch:
//
//   * a fetch with `cache: "no-store"`             → noStoreFetch (FIX-1208)
//   * cookies() / headers() / noStore()            → trackDynamicDataAccessed
//   * request.headers / nextUrl.search / …        → only on the tracking proxy,
//                                                     i.e. WITHOUT force-dynamic
//   * a module exporting POST/DELETE/PATCH/OPTIONS → `hasNonStaticMethods`, set
//     for the whole module at request time (module.js: `revalidate = 0`)
//
// The last one is why a GET+POST route is out of scope here: its GET reads are
// already "auto no cache". Note Next's list: `handlers.POST || handlers.POST ||
// handlers.DELETE || handlers.PATCH || handlers.OPTIONS` — POST twice, no PUT.
// A GET+PUT module is NOT covered and stays in scope.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// In scope: a `route.ts` that exports GET and none of Next's non-static methods,
// or a non-route helper under app/api/ (e.g. browse/execute.ts, which builds the
// client /api/browse reads through), that calls createAdminClient( in code.
// Protected when ANY of:
//   * every createAdminClient( call is exactly createAdminClient({ fetch: noStoreFetch })
//   * the file calls cookies() / headers() / noStore()  (request-bound: lowers
//     revalidate — file level, so it trusts the call to precede the reads)
//   * the file carries `// no-store-exempt: <reason>`
// A bare `no-store` string is NOT protection: a response header or an unrelated
// fetch's option says nothing about the admin client (cc-161 read 2 — three
// routes carried one and were still exposed).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

/** Next 14.2's `hasNonStaticMethods` list, de-duplicated. No PUT — see header. */
export const NON_STATIC_METHODS = ["POST", "DELETE", "PATCH", "OPTIONS"];

/**
 * Replace // and /* *\/ comment bodies with spaces (length-preserving, newlines
 * kept), string-aware. Copied from check-render-timeouts.mjs.
 */
export function stripComments(src) {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < src.length) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Does the (comment-stripped) module export this HTTP method? */
export function exportsMethod(code, method) {
  return (
    new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`).test(code) ||
    new RegExp(`export\\s+(const|let)\\s+${method}\\b`).test(code) ||
    new RegExp(`export\\s*\\{[^}]*\\b(as\\s+)?${method}\\b[^}]*\\}`).test(code)
  );
}

/**
 * Classify one file's source. `isRoute` is true for a `route.ts`.
 * Returns { inScope, why, calls, noStoreCalls, ok, escape }.
 */
export function classifySource(raw, { isRoute }) {
  const code = stripComments(raw);
  const calls = (code.match(/\bcreateAdminClient\s*\(/g) ?? []).length;
  if (calls === 0) return { inScope: false, why: "no createAdminClient( call", calls };
  if (isRoute) {
    if (!exportsMethod(code, "GET")) return { inScope: false, why: "no GET export", calls };
    const nonStatic = NON_STATIC_METHODS.filter((m) => exportsMethod(code, m));
    if (nonStatic.length > 0) {
      return { inScope: false, why: `exports ${nonStatic.join("/")} — module-level revalidate 0`, calls };
    }
  }
  const noStoreCalls = (code.match(/\bcreateAdminClient\(\{\s*fetch:\s*noStoreFetch\s*\}\)/g) ?? []).length;
  let escape = null;
  if (noStoreCalls === calls) escape = "noStoreFetch";
  else if (/\b(cookies|headers)\s*\(\s*\)/.test(code)) escape = "request-bound";
  else if (/\b(unstable_)?noStore\s*\(\s*\)/.test(code)) escape = "noStore()";
  // The reason must be on the marker's own line: `\s*` would cross the newline
  // and let an empty `// no-store-exempt:` borrow the next line's code.
  else if (/\/\/[ \t]*no-store-exempt:[ \t]*\S/.test(raw)) escape = "exempt";
  return { inScope: true, why: isRoute ? "GET route" : "api helper", calls, noStoreCalls, ok: escape !== null, escape };
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every in-scope file under `appDir` (apps/civitics/app): each route.ts, plus
 * each non-test .ts helper under app/api/. Paths are relative to `root`.
 */
export function scanApp(appDir, root = appDir) {
  const results = [];
  const apiDir = join(appDir, "api");
  for (const p of walk(appDir, [])) {
    const name = basename(p);
    const isRoute = name === "route.ts";
    const isApiHelper =
      !isRoute &&
      p.startsWith(apiDir) &&
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts");
    if (!isRoute && !isApiHelper) continue;
    const r = classifySource(readFileSync(p, "utf8"), { isRoute });
    if (!r.inScope) continue;
    results.push({ file: relative(root, p).split("\\").join("/"), ...r });
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}
