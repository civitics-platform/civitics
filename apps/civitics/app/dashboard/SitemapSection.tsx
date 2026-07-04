import { SectionCard, SectionHeader } from "@civitics/ui";

type Route = {
  href: string;
  icon: string;
  title: string;
  description: string;
};

const ROUTES: Route[] = [
  {
    href: "/",
    icon: "🏠",
    title: "Home",
    description: "Featured officials, proposals, agencies, and initiatives.",
  },
  {
    href: "/officials",
    icon: "👤",
    title: "Officials",
    description: "Senators, representatives, judges, and state officials.",
  },
  {
    href: "/proposals",
    icon: "📋",
    title: "Proposals",
    description: "Federal rules and bills open for public comment.",
  },
  {
    href: "/agencies",
    icon: "🏛",
    title: "Agencies",
    description: "Federal departments, their rules, and key officials.",
  },
  {
    href: "/initiatives",
    icon: "🗳",
    title: "Civic Initiatives",
    description: "Citizen-authored problems, deliberations, and resolutions.",
  },
  {
    href: "/graph",
    icon: "🔗",
    title: "Connection Graph",
    description: "Follow money, votes, and oversight across entities.",
  },
  {
    href: "/search",
    icon: "🔍",
    title: "Search",
    description: "Global search across officials, proposals, agencies, and donors.",
  },
  {
    href: "/dashboard",
    icon: "📊",
    title: "Transparency Dashboard",
    description: "Live platform stats, pipelines, costs, and data quality.",
  },
  {
    href: "/desk",
    icon: "👋",
    title: "Your Desk",
    description: "Receipts, inbox, watchlist, and constituent verification.",
  },
  {
    href: "/proposals/problem",
    icon: "💡",
    title: "Post a Problem",
    description: "Raise an issue for the community to deliberate on.",
  },
];

export function SitemapSection() {
  return (
    <SectionCard>
      <SectionHeader
        icon="🗺"
        title="Explore the Platform"
        description="A guided map of every major area of Civitics."
      />
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ROUTES.map((r) => (
          <a
            key={r.href}
            href={r.href}
            className="group rounded-lg border border-rule bg-card p-4 transition-colors duration-150 hover:border-accent/50 hover:bg-ink/5"
          >
            <div className="flex items-start gap-3">
              <span className="text-xl leading-none" aria-hidden="true">
                {r.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink group-hover:text-accent">
                    {r.title}
                  </h3>
                  <code className="truncate rounded bg-ink/10 px-1.5 py-0.5 text-[10px] font-mono text-ink-soft">
                    {r.href}
                  </code>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                  {r.description}
                </p>
              </div>
              <span
                aria-hidden="true"
                className="text-xs text-ink-soft/50 transition-colors duration-150 group-hover:text-accent"
              >
                →
              </span>
            </div>
          </a>
        ))}
      </div>
      <p className="mt-4 text-xs text-ink-soft">
        New here? Start with <a href="/proposals" className="text-accent hover:underline">Proposals</a> to see what&apos;s open for comment, or explore the <a href="/graph" className="text-accent hover:underline">Connection Graph</a> to follow the money.
      </p>
    </SectionCard>
  );
}
