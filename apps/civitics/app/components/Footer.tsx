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
    <footer className="border-t border-gray-200 bg-white mt-auto">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          {/* Brand + mission */}
          <div className="flex flex-col gap-2 max-w-xs">
            <a href="/" className="flex items-center gap-2 group w-fit">
              <div className="flex h-7 w-7 items-center justify-center rounded bg-indigo-600">
                <span className="text-[10px] font-bold text-white">CV</span>
              </div>
              <span className="text-sm font-semibold tracking-tight text-gray-900 group-hover:text-indigo-700 transition-colors">
                Civitics
              </span>
            </a>
            <p className="text-xs text-gray-400 leading-relaxed">
              Restoring democratic power to its rightful owners — the people.
            </p>
          </div>

          {/* Nav links */}
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
            {NAV_LINKS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>

        {/* Bottom bar */}
        <div className="mt-6 flex flex-col gap-2 border-t border-gray-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-gray-400">
            © {year} Civitics. Official comment submission is always free.
          </p>
          <div className="flex items-center gap-4">
            {LEGAL_LINKS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                {item.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
