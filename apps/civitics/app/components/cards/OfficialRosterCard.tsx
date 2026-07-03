import Link from "next/link";
import { SyntheticMark } from "../integrity/Synthetic";

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
  is_synthetic?: boolean;
};

// Party reads as blue/red ink, never a wash; independents stay ink-outline
// (no purple token exists by design — FIX-552 precedent).
const PARTY_STYLES: Record<string, string> = {
  democratic: "bg-civic-blue/10 text-civic-blue",
  democrat: "bg-civic-blue/10 text-civic-blue",
  republican: "bg-accent/10 text-accent",
  independent: "border border-ink/40 text-ink",
  nonpartisan: "bg-ink/5 text-ink-soft",
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
    ? PARTY_STYLES[official.party.toLowerCase()] ?? "bg-ink/5 text-ink-soft"
    : null;

  return (
    <Link
      href={`/officials/${official.id}`}
      className="group flex items-center gap-3 border border-rule bg-card p-3 transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {official.photo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={official.photo_url}
          alt=""
          className="h-10 w-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink/5 font-mono text-xs font-semibold text-ink-soft">
          {initials(official.full_name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-ink transition-colors group-hover:text-accent">
          {official.full_name}
          {official.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
        </h3>
        <p className="truncate text-xs text-ink-soft">
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
