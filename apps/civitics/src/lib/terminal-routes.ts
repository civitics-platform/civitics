/**
 * FIX-1096 — the single source of truth for which routes render as dark
 * "terminal" instruments rather than the light "public record" surface.
 *
 * Two consumers, and they must never drift:
 *   - app/components/ChromeTheme.tsx wraps NavBar + page + Footer in the
 *     data-theme="terminal" token scope on these routes, so the site chrome
 *     matches the instrument instead of sandwiching it between a light
 *     masthead and a light footer.
 *   - the pages themselves still carry their own data-theme="terminal"
 *     wrapper (dashboard/page.tsx, dashboard/loading.tsx, search's
 *     ExplorerPage/BrowseLanding, …). Nesting the scope is a no-op — the
 *     inner block re-binds the same vars to the same values — and keeping it
 *     means each page stays self-contained and correct even if it is ever
 *     rendered outside this layout.
 *
 * /graph is deliberately ABSENT. It owns its chrome outright: NavBar returns
 * null on /graph and FooterGate suppresses the Footer, so there is no chrome
 * here to theme. Adding it would be harmless but misleading.
 */

/** Route prefixes whose chrome renders in the terminal token scope. */
export const TERMINAL_ROUTE_PREFIXES = ["/dashboard", "/search"] as const;

/**
 * True when `pathname` is one of the terminal routes or a subpath of one.
 * Matches on segment boundaries, so a future "/searchable" route would NOT
 * be caught by the "/search" prefix.
 */
export function isTerminalRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return TERMINAL_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
