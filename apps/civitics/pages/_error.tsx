/**
 * FIX-1236 — the page a visitor sees when a revalidate page's FIRST render is
 * degraded.
 *
 * `assertRenderNotDegraded()` (FIX-1227) ends an ISR render whose reads did not
 * complete, so a timed-out render is never cached. That bailout is not caught
 * by `app/error.tsx` (its digest is DYNAMIC_SERVER_USAGE): Next renders the
 * PAGES-ROUTER error page, and with no `pages/` directory that was the bare
 * "500: Internal Server Error". A background revalidation keeps the last good
 * page, so only a first render (a cold id) reaches this.
 *
 * Why `_error.tsx` + `getInitialProps` and not `pages/500.tsx` (cc-165 read 3,
 * measured on `next start`, next@14.2.35): both replace the body, but 500.tsx is
 * auto-exported static and the 500 then carries NO Cache-Control (an ETag
 * instead). `_error` with `getInitialProps` keeps
 * `private, no-cache, no-store, max-age=0, must-revalidate`, and it does not
 * appear in the route table. Craig chose it 2026-09-29.
 *
 * Inline styles only: `app/layout.tsx`'s globals.css is App-Router-only and
 * reaches no pages-router page. 404s never land here — `app/not-found.tsx`
 * owns them.
 */

import type { NextPageContext } from "next";
import Head from "next/head";

interface ErrorProps {
  statusCode: number;
}

const css = `
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #57534e; --rule: #e7e5e4; --link: #1d4ed8; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --rule: #292524; --link: #93c5fd; }
}
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 36rem; margin: 0 auto; padding: 18vh 1rem 4rem; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 .75rem; }
p { color: var(--muted); margin: 0 0 1.5rem; }
nav { display: flex; gap: 1.25rem; border-top: 1px solid var(--rule); padding-top: 1rem; }
a { color: var(--link); }
`;

function ErrorPage({ statusCode }: ErrorProps) {
  const busy = statusCode >= 500;
  const title = busy ? "This record is busy right now" : "This page could not be found";
  return (
    <>
      <Head>
        <title>{busy ? "Busy — Civitics" : "Not found — Civitics"}</title>
        <meta name="robots" content="noindex" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{css}</style>
      </Head>
      <main>
        <h1>{title}</h1>
        <p>
          {busy
            ? "The page took too long to load. Nothing is lost — reload in a moment and it will be here."
            : "Check the address, or start again from the home page."}
        </p>
        <nav>
          {/* An empty href is the current URL: a reload that needs no JS. */}
          {busy ? <a href="">Reload this page</a> : null}
          {/* A plain anchor on purpose: "/" is an App-Router page, and this
              pages-router page must not pull in a client router to reach it. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/">Go to the home page</a>
        </nav>
      </main>
    </>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext): ErrorProps => {
  const statusCode = res ? res.statusCode : err?.statusCode ?? 500;
  return { statusCode };
};

export default ErrorPage;
