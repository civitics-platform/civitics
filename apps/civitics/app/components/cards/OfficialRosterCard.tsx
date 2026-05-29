import Link from "next/link";

// Slim presentational roster card (name + role + party). Deliberately lighter
// than the directory's client-side OfficialCard (which fetches votes/donations);
// this one just renders a passed-in row and links to the full profile.
export type OfficialRosterData = {
  id: string;
  full_name: string;
  role_title: string;
  party: string | null;
  photo_url: string | null;
  district_name: string | null;
};

const PARTY_STYLES: Record<string, string> = {
  democratic: "bg-blue-50 text-blue-700",
  democrat: "bg-blue-50 text-blue-700",
  republican: "bg-red-50 text-red-700",
  independent: "bg-purple-50 text-purple-700",
  nonpartisan: "bg-gray-50 text-gray-600",
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function OfficialRosterCard({ official }: { official: OfficialRosterData }) {
  const partyCls = official.party
    ? PARTY_STYLES[official.party.toLowerCase()] ?? "bg-gray-50 text-gray-600"
    : null;

  return (
    <Link
      href={`/officials/${official.id}`}
      className="group flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 transition-all hover:border-gray-300 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      {official.photo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={official.photo_url}
          alt=""
          className="h-10 w-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-500">
          {initials(official.full_name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-gray-900 group-hover:text-indigo-700">
          {official.full_name}
        </h3>
        <p className="truncate text-xs text-gray-500">
          {official.role_title}
          {official.district_name ? ` · ${official.district_name}` : ""}
        </p>
      </div>
      {partyCls && official.party && (
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${partyCls}`}>
          {official.party}
        </span>
      )}
    </Link>
  );
}
