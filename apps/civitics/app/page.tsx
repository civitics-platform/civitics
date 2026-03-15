// Placeholder data — wired to real APIs in Phase 1
const OFFICIALS = [
  {
    id: "1",
    name: "Maria Elena Vasquez",
    role: "U.S. Senator",
    party: "D",
    state: "California",
    photoInitials: "MV",
    donorsOnRecord: 4821,
    votesThisTerm: 312,
    promisesKept: 14,
    promisesMade: 22,
  },
  {
    id: "2",
    name: "Thomas R. Hargrove",
    role: "U.S. Representative",
    party: "R",
    state: "Texas · District 21",
    photoInitials: "TH",
    donorsOnRecord: 2103,
    votesThisTerm: 289,
    promisesKept: 9,
    promisesMade: 17,
  },
  {
    id: "3",
    name: "Sandra K. Okonkwo",
    role: "U.S. Senator",
    party: "D",
    state: "New York",
    photoInitials: "SO",
    donorsOnRecord: 6447,
    votesThisTerm: 318,
    promisesKept: 19,
    promisesMade: 24,
  },
  {
    id: "4",
    name: "James F. Bellamy",
    role: "U.S. Representative",
    party: "R",
    state: "Florida · District 7",
    photoInitials: "JB",
    donorsOnRecord: 1892,
    votesThisTerm: 301,
    promisesKept: 6,
    promisesMade: 18,
  },
];

const PROPOSALS = [
  {
    id: "1",
    number: "S. 2847",
    title: "Clean Energy Investment and Grid Modernization Act",
    status: "In Committee",
    statusColor: "amber",
    chamber: "Senate",
    introduced: "Feb 14, 2026",
    commentDeadline: "Mar 28, 2026",
    summary:
      "Authorizes $180B in federal investment for renewable energy infrastructure and transmission grid upgrades over 10 years.",
    commentCount: 12841,
    openForComment: true,
  },
  {
    id: "2",
    number: "HR 4291",
    title: "Algorithmic Accountability and Transparency Act",
    status: "Floor Vote",
    statusColor: "blue",
    chamber: "House",
    introduced: "Jan 8, 2026",
    commentDeadline: null,
    summary:
      "Requires federal agencies and large platforms to audit automated decision systems for bias and provide plain-language disclosures.",
    commentCount: 31204,
    openForComment: false,
  },
  {
    id: "3",
    number: "EPA-HQ-OAR-2026-0112",
    title: "Proposed Rule: National Ambient Air Quality Standards Revision",
    status: "Open Comment",
    statusColor: "green",
    chamber: "Regulatory",
    introduced: "Feb 1, 2026",
    commentDeadline: "Apr 2, 2026",
    summary:
      "Proposes updated particulate matter standards (PM2.5) lowering the annual limit from 12 to 9 micrograms per cubic meter.",
    commentCount: 8203,
    openForComment: true,
  },
];

const AGENCIES = [
  {
    id: "1",
    acronym: "EPA",
    name: "Environmental Protection Agency",
    activeProposals: 14,
    annualBudgetB: 9.7,
    openCommentPeriods: 3,
    employeeCount: 14600,
  },
  {
    id: "2",
    acronym: "FTC",
    name: "Federal Trade Commission",
    activeProposals: 7,
    annualBudgetB: 0.43,
    openCommentPeriods: 2,
    employeeCount: 1100,
  },
  {
    id: "3",
    acronym: "SEC",
    name: "Securities and Exchange Commission",
    activeProposals: 11,
    annualBudgetB: 2.1,
    openCommentPeriods: 4,
    employeeCount: 4600,
  },
  {
    id: "4",
    acronym: "DOE",
    name: "Department of Energy",
    activeProposals: 22,
    annualBudgetB: 48.2,
    openCommentPeriods: 6,
    employeeCount: 14000,
  },
];

const PARTY_STYLES: Record<string, { border: string; badge: string; text: string }> = {
  D: { border: "border-blue-400", badge: "bg-blue-100 text-blue-800", text: "text-blue-700" },
  R: { border: "border-red-400", badge: "bg-red-100 text-red-800", text: "text-red-700" },
  I: { border: "border-purple-400", badge: "bg-purple-100 text-purple-800", text: "text-purple-700" },
};

const STATUS_STYLES: Record<string, string> = {
  amber: "bg-amber-100 text-amber-800",
  blue: "bg-blue-100 text-blue-800",
  green: "bg-emerald-100 text-emerald-800",
  red: "bg-red-100 text-red-800",
};

function NavBar() {
  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded bg-indigo-600">
              <span className="text-xs font-bold text-white">CV</span>
            </div>
            <span className="text-lg font-semibold tracking-tight text-gray-900">Civitics</span>
          </div>

          {/* Nav links */}
          <nav className="hidden md:flex items-center gap-6">
            {[
              { label: "Officials", href: "/officials" },
              { label: "Proposals", href: "#" },
              { label: "Agencies", href: "#" },
              { label: "Spending", href: "#" },
              { label: "Connections", href: "/graph" },
            ].map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
              >
                {item.label}
              </a>
            ))}
          </nav>

          {/* Right side */}
          <div className="flex items-center gap-3">
            <a
              href="#"
              className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
            >
              Sign in
            </a>
            <a
              href="#"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              Get started
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="border-b border-gray-200 bg-white py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Public beta — all data is free to access
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
            Democracy with receipts.
          </h1>
          <p className="mt-4 text-lg text-gray-600 leading-relaxed">
            Every vote, donor, promise, and dollar — connected, searchable, and permanent. Official
            comment submission is always free. No account required to read anything.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="/officials"
              className="rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              Find your representatives
            </a>
            <a
              href="#"
              className="rounded-md border border-gray-300 bg-white px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Browse open comment periods
            </a>
          </div>

          {/* Stats bar */}
          <div className="mt-12 grid grid-cols-2 gap-6 sm:grid-cols-4">
            {[
              { label: "Officials tracked", value: "14,821" },
              { label: "Active proposals", value: "3,204" },
              { label: "Donor records", value: "48.2M" },
              { label: "Comments submitted", value: "891,440" },
            ].map((stat) => (
              <div key={stat.label}>
                <p className="text-2xl font-bold text-gray-900">{stat.value}</p>
                <p className="mt-0.5 text-sm text-gray-500">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHeader({
  title,
  description,
  href,
  linkLabel = "View all",
}: {
  title: string;
  description: string;
  href: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </div>
      <a
        href={href}
        className="shrink-0 text-sm font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
      >
        {linkLabel} →
      </a>
    </div>
  );
}

function OfficialsSection() {
  return (
    <section>
      <SectionHeader
        title="Officials"
        description="Every elected and appointed official — votes, donors, and promises on record."
        href="/officials"
        linkLabel="Browse all officials"
      />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {OFFICIALS.map((official) => {
          const party = PARTY_STYLES[official.party] ?? PARTY_STYLES["I"]!;
          const keptPct = Math.round((official.promisesKept / official.promisesMade) * 100);
          return (
            <a
              key={official.id}
              href="/officials"
              className="group block rounded-lg border border-gray-200 bg-white p-4 hover:border-indigo-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 bg-gray-100 text-xs font-semibold text-gray-600 ${party.border}`}
                >
                  {official.photoInitials}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900 group-hover:text-indigo-700">
                    {official.name}
                  </p>
                  <p className="truncate text-xs text-gray-500">{official.role}</p>
                </div>
              </div>
              <p className="mt-2 text-xs text-gray-400">{official.state}</p>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3">
                <div className="text-center">
                  <p className="text-sm font-semibold text-gray-900">
                    {official.donorsOnRecord.toLocaleString()}
                  </p>
                  <p className="text-[10px] text-gray-400">Donors</p>
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-gray-900">{official.votesThisTerm}</p>
                  <p className="text-[10px] text-gray-400">Votes</p>
                </div>
                <div className="text-center">
                  <p className={`text-sm font-semibold ${keptPct >= 70 ? "text-emerald-600" : keptPct >= 50 ? "text-amber-600" : "text-red-600"}`}>
                    {keptPct}%
                  </p>
                  <p className="text-[10px] text-gray-400">Promises</p>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}

function ProposalsSection() {
  return (
    <section>
      <SectionHeader
        title="Proposals"
        description="Bills, regulations, and rules open for public comment — submit your position for free."
        href="#"
        linkLabel="Browse all proposals"
      />
      <div className="mt-4 flex flex-col gap-3">
        {PROPOSALS.map((proposal) => (
          <a
            key={proposal.id}
            href="#"
            className="group block rounded-lg border border-gray-200 bg-white p-5 hover:border-indigo-300 hover:shadow-sm transition-all"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
                  {proposal.number}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[proposal.statusColor] ?? STATUS_STYLES["amber"]}`}
                >
                  {proposal.status}
                </span>
                {proposal.openForComment && (
                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                    Comment open
                  </span>
                )}
              </div>
              {proposal.commentDeadline && (
                <span className="text-xs text-gray-400">
                  Deadline: {proposal.commentDeadline}
                </span>
              )}
            </div>
            <h3 className="mt-2 text-sm font-semibold text-gray-900 group-hover:text-indigo-700">
              {proposal.title}
            </h3>
            <p className="mt-1.5 text-sm text-gray-500 leading-relaxed">{proposal.summary}</p>
            <div className="mt-3 flex items-center gap-4 text-xs text-gray-400">
              <span>{proposal.chamber}</span>
              <span>·</span>
              <span>Introduced {proposal.introduced}</span>
              <span>·</span>
              <span>{proposal.commentCount.toLocaleString()} comments on record</span>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

function AgenciesSection() {
  return (
    <section>
      <SectionHeader
        title="Agencies"
        description="Federal agencies, their budgets, active rulemaking, and open comment periods."
        href="#"
        linkLabel="Browse all agencies"
      />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {AGENCIES.map((agency) => (
          <a
            key={agency.id}
            href="#"
            className="group block rounded-lg border border-gray-200 bg-white p-4 hover:border-indigo-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 font-mono text-xs font-bold text-gray-600">
                {agency.acronym}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900 group-hover:text-indigo-700">
                  {agency.acronym}
                </p>
                <p className="truncate text-xs text-gray-500">{agency.name}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3">
              <div className="text-center">
                <p className="text-sm font-semibold text-gray-900">{agency.activeProposals}</p>
                <p className="text-[10px] text-gray-400">Active rules</p>
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-gray-900">
                  ${agency.annualBudgetB}B
                </p>
                <p className="text-[10px] text-gray-400">Budget</p>
              </div>
              <div className="text-center">
                <p className={`text-sm font-semibold ${agency.openCommentPeriods > 0 ? "text-emerald-600" : "text-gray-400"}`}>
                  {agency.openCommentPeriods}
                </p>
                <p className="text-[10px] text-gray-400">Open now</p>
              </div>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

function CommentBanner() {
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-indigo-900">
            Official comment submission is always free.
          </p>
          <p className="mt-0.5 text-sm text-indigo-700">
            Submitting a public comment to a federal agency is a constitutional right. No account, no
            credits, no fees — ever.
          </p>
        </div>
        <a
          href="#"
          className="shrink-0 rounded-md border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 transition-colors"
        >
          View open periods →
        </a>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar />
      <Hero />
      <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-12">
          <CommentBanner />
          <OfficialsSection />
          <ProposalsSection />
          <AgenciesSection />
        </div>
      </main>
      <footer className="mt-16 border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-gray-500">
              Civitics — open civic infrastructure. All data is public record.
            </p>
            <p className="text-xs text-gray-400">Phase 0 · Placeholder data</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
