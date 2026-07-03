// Custom 404 page — rendered by Next.js App Router for notFound() calls and missing routes.
// No "use client" — server component. No NavBar or data-fetching imports.

import { StampMark } from "./components/brand/StampMark";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-lg border border-rule bg-card p-10 text-center">
        <div className="mb-6 flex justify-center text-accent">
          <StampMark size={56} />
        </div>

        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-soft">
          Error 404 — No such filing
        </p>
        <h1 className="mt-3 font-serif text-3xl font-black uppercase tracking-[0.06em] text-accent">
          Record Not Found
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">
          The page you&apos;re looking for isn&apos;t in the record. It may have
          been moved, or it never existed.
        </p>

        <div className="mt-8 border-t border-rule pt-6">
          <a
            href="/"
            className="text-sm font-medium text-accent hover:underline"
          >
            Return to the ledger →
          </a>
        </div>

        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-soft">
          <a href="/officials" className="transition-colors hover:text-accent">
            Officials
          </a>
          <span className="mx-2">·</span>
          <a href="/proposals" className="transition-colors hover:text-accent">
            Proposals
          </a>
          <span className="mx-2">·</span>
          <a href="/search" className="transition-colors hover:text-accent">
            Search
          </a>
        </p>
      </div>
    </div>
  );
}
