"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { GlobalSearch } from "./GlobalSearch";
import { AuthButton } from "./AuthButton";
import { NotificationsBell } from "./NotificationsBell";
import { PorticoMark } from "./brand/PorticoMark";

type NavGroup = {
  label: string;
  /** Dropdown group label, e.g. "The Record" */
  heading: string;
  items: { label: string; href: string; note?: string }[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Government",
    heading: "The Record",
    items: [
      { label: "Officials",     href: "/officials",     note: "every seat" },
      { label: "Proposals",     href: "/proposals",     note: "bills & rules" },
      { label: "Jurisdictions", href: "/jurisdictions", note: "federal → local" },
      { label: "Institutions",  href: "/institutions",  note: "agencies & bodies" },
      { label: "Donors",        href: "/donors",        note: "campaign finance" },
    ],
  },
  {
    label: "Civic",
    heading: "The People",
    items: [
      { label: "Initiatives",      href: "/initiatives",    note: "citizen-led" },
      { label: "Investigations",   href: "/investigations", note: "cited case files" },
      { label: "Meetings",         href: "/meetings",       note: "public sessions" },
      { label: "State of Franklin", href: "/franklin",      note: "demonstration" },
    ],
  },
  {
    label: "Tools",
    heading: "Instruments",
    items: [
      { label: "Search",             href: "/search",    note: "⌘K" },
      { label: "Connection Graph",   href: "/graph" },
      { label: "Platform Dashboard", href: "/dashboard" },
    ],
  },
];

export function NavBar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // Set client-side only: rendering the live date during SSR risks a
  // hydration mismatch (timezone / midnight crossing).
  const [dateLabel, setDateLabel] = useState("");

  useEffect(() => {
    setDateLabel(
      new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    );
  }, []);

  // Routes that render their own chrome (graph views, auth flows).
  if (pathname?.startsWith("/graph") || pathname?.startsWith("/auth/")) {
    return null;
  }

  return (
    <header className="bg-paper">
      {/* Skip to main content — visually hidden until focused */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-paper focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
      >
        Skip to main content
      </a>

      {/* Topline strip */}
      <div className="border-b border-rule">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-soft sm:px-6 lg:px-8">
          <span>
            <span className="text-accent">●</span>&nbsp; Beta — All data is public record
          </span>
          <span suppressHydrationWarning>{dateLabel}</span>
        </div>
      </div>

      {/* Masthead */}
      <div className="border-b-[3px] border-double border-ink">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-4 sm:px-6 lg:px-8">
          {/* Mark + wordmark */}
          <a
            href="/"
            className="flex shrink-0 items-center gap-3 rounded-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            <PorticoMark size={38} />
            <span className="flex flex-col">
              <span className="font-serif text-[22px] font-black uppercase leading-none tracking-[0.12em]">
                Civitics
              </span>
              <span className="mt-1 font-mono text-[9px] font-medium uppercase tracking-[0.18em] text-ink-soft">
                The Public Ledger
              </span>
            </span>
          </a>

          {/* Desktop nav — grouped dropdowns, hover + keyboard (focus-within) */}
          <nav aria-label="Main" className="ml-auto hidden items-center gap-1 md:flex">
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="group relative">
                <button
                  type="button"
                  className="flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-xs font-semibold uppercase tracking-[0.05em] text-ink transition-colors group-hover:border-accent group-hover:text-accent group-focus-within:border-accent group-focus-within:text-accent focus-visible:outline-none"
                >
                  {group.label}
                  <span
                    aria-hidden="true"
                    className="text-[8px] text-ink-soft transition-transform group-hover:rotate-180 group-hover:text-accent group-focus-within:rotate-180 group-focus-within:text-accent"
                  >
                    ▼
                  </span>
                </button>
                <div className="invisible absolute left-0 top-full z-50 min-w-[230px] translate-y-1.5 border border-ink bg-card pb-1.5 pt-1 opacity-0 shadow-[0_14px_30px_rgba(28,26,22,0.18)] transition-all group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100">
                  <div className="mb-1 border-b border-rule px-4 pb-2 pt-2 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-accent">
                    {group.heading}
                  </div>
                  {group.items.map((item) => (
                    <a
                      key={item.label}
                      href={item.href}
                      className="flex items-baseline justify-between gap-4 px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-2 hover:text-accent focus-visible:bg-paper-2 focus-visible:text-accent focus-visible:outline-none"
                    >
                      {item.label}
                      {item.note && (
                        <span className="whitespace-nowrap font-mono text-[10px] text-ink-soft">
                          {item.note}
                        </span>
                      )}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </nav>

          {/* Desktop search */}
          <div className="hidden lg:block">
            <GlobalSearch variant="nav" />
          </div>

          {/* Right side: notifications + auth + hamburger */}
          <div className="flex items-center gap-2 md:shrink-0">
            <NotificationsBell />
            <AuthButton />
            {/* Hamburger — mobile only */}
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md p-2 text-ink-soft transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden"
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav"
              onClick={() => setMobileOpen((o) => !o)}
            >
              {mobileOpen ? (
                // X icon
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                // Hamburger icon
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile menu — same groups as accordion sections */}
      {mobileOpen && (
        <div id="mobile-nav" className="border-b border-rule bg-paper px-4 py-3 md:hidden">
          {/* Mobile search */}
          <div className="mb-3">
            <GlobalSearch variant="nav" />
          </div>
          <nav aria-label="Mobile" className="flex flex-col">
            {NAV_GROUPS.map((group) => {
              const isOpen = openGroup === group.label;
              return (
                <div key={group.label} className="border-b border-rule last:border-b-0">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2.5 text-xs font-semibold uppercase tracking-[0.05em] text-ink transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                    aria-expanded={isOpen}
                    onClick={() => setOpenGroup(isOpen ? null : group.label)}
                  >
                    {group.label}
                    <span
                      aria-hidden="true"
                      className={`text-[8px] text-ink-soft transition-transform ${isOpen ? "rotate-180" : ""}`}
                    >
                      ▼
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pb-2">
                      {group.items.map((item) => (
                        <a
                          key={item.label}
                          href={item.href}
                          className="flex items-baseline justify-between gap-4 rounded-md px-5 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-paper-2 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                          onClick={() => setMobileOpen(false)}
                        >
                          {item.label}
                          {item.note && (
                            <span className="whitespace-nowrap font-mono text-[10px] text-ink-soft">
                              {item.note}
                            </span>
                          )}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}
