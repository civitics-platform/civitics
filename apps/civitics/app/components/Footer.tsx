import { PorticoMark } from "./brand/PorticoMark";

const NAV_LINKS = [
  { label: "Officials",   href: "/officials" },
  { label: "Proposals",  href: "/proposals" },
  { label: "Initiatives",href: "/initiatives" },
  { label: "Agencies",   href: "/agencies" },
  { label: "Graph",      href: "/graph" },
  { label: "Dashboard",  href: "/dashboard" },
];

const LEGAL_LINKS = [
  { label: "Data Sources", href: "/about/sources" },
  { label: "Privacy",      href: "/privacy" },
  { label: "Terms",        href: "/terms" },
];

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t-[3px] border-double border-ink bg-paper">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          {/* Brand + mission */}
          <div className="flex max-w-sm flex-col gap-3">
            <a href="/" className="group flex w-fit items-center gap-2.5 text-ink">
              <PorticoMark size={26} />
              <span className="font-serif text-sm font-black uppercase tracking-[0.12em] group-hover:text-accent transition-colors">
                Civitics
              </span>
            </a>
            <p className="font-serif text-base italic leading-relaxed text-ink">
              &ldquo;Restoring democratic power to its rightful owners — the people.&rdquo;
            </p>
          </div>

          {/* Nav links */}
          <nav
            aria-label="Footer"
            className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-[11px] font-medium uppercase tracking-[0.1em]"
          >
            {NAV_LINKS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="text-ink-soft hover:text-accent transition-colors"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>

        {/* Bottom bar */}
        <div className="mt-6 flex flex-col gap-2 border-t border-rule pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
            © {year} Civitics · Official comment submission is always free
          </p>
          <div className="flex items-center gap-5">
            {LEGAL_LINKS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-ink-soft hover:text-accent transition-colors"
              >
                {item.label}
              </a>
            ))}
            <span className="font-mono text-[11px] tabular-nums text-rule">
              v:{process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev"}
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
