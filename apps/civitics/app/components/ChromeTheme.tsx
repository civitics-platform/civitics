"use client";

import { usePathname } from "next/navigation";
import { isTerminalRoute } from "@/lib/terminal-routes";

/**
 * FIX-1096 — puts the site chrome (NavBar + Footer) inside the terminal token
 * scope on the terminal routes, and leaves it in paper mode everywhere else.
 *
 * WHY A CLIENT COMPONENT IS THE RIGHT MECHANISM (and does NOT flash):
 *
 * Client components are server-rendered into the initial HTML, and
 * `usePathname()` resolves during that server render — so `data-theme` is
 * already in the SSR bytes on the first paint. No mount-time class swap, no
 * flash of light chrome. The same layout stack has relied on exactly this for
 * months: NavBar returns null on /graph and FooterGate suppresses the Footer
 * there, both via usePathname. Verified against prod before this landed —
 * `curl /graph` returns 0 `<footer>` and no NavBar markup, while
 * `curl /officials` returns both. If usePathname were client-only, /graph
 * would ship the chrome in its HTML and tear it out after hydration.
 *
 * The alternative considered and REJECTED: middleware stamping a theme header
 * that the root layout reads via `headers()`. Reading headers() in the ROOT
 * layout opts every route in the app out of static rendering — it would kill
 * the generateStaticParams/ISR strategy wholesale to answer a question the
 * route path already answers. Route-group layouts would also work, but cost a
 * ~25-directory move of the entire app/ tree for the same result.
 *
 * The wrapper renders on EVERY route (only the attributes vary) so the DOM
 * shape is identical everywhere — that keeps the print rules in globals.css
 * matching a single, stable selector (`[data-site-chrome] > header`).
 */
export function ChromeTheme({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const terminal = isTerminalRoute(pathname);

  return (
    <div
      data-site-chrome=""
      // Attribute is omitted entirely (not set to a falsy string) in paper
      // mode, so paper routes keep today's exact cascade.
      data-theme={terminal ? "terminal" : undefined}
      // Inside the scope bg-paper/text-ink re-resolve to the terminal surface,
      // so the chrome band above the masthead and below the footer is dark
      // too. min-h-screen keeps that surface covering short pages.
      className={terminal ? "min-h-screen bg-paper text-ink" : undefined}
    >
      {children}
    </div>
  );
}
