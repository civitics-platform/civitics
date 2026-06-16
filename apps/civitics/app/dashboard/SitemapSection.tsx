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
            className="group rounded-lg border border-gray-200 bg-white p-4 transition-colors duration-150 hover:border-blue-300 hover:bg-blue-50/40"
          >
            <div className="flex items-start gap-3">
              <span className="text-xl leading-none" aria-hidden="true">
                {r.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-gray-900 group-hover:text-blue-700">
                    {r.title}
                  </h3>
                  <code className="truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-600">
                    {r.href}
                  </code>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-gray-600">
                  {r.description}
                </p>
              </div>
              <span
                aria-hidden="true"
                className="text-xs text-gray-300 transition-colors duration-150 group-hover:text-blue-500"
              >
                →
              </span>
            </div>
          </a>
        ))}
      </div>
      <p className="mt-4 text-xs text-gray-500">
        New here? Start with <a href="/proposals" className="text-blue-600 hover:underline">Proposals</a> to see what&apos;s open for comment, or explore the <a href="/graph" className="text-blue-600 hover:underline">Connection Graph</a> to follow the money.
      </p>
    </SectionCard>
  );
}
