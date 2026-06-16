import { FollowButton } from "../../components/FollowButton";

export type WatchingItem = {
  id: string;
  entity_type: "official" | "agency" | "jurisdiction";
  entity_id: string;
  label: string;
  href: string;
  chip: string;
};

/**
 * Watching — the user's `user_follows`, resolved to label + href via the shared
 * entity-label resolver (FIX-597). Unfollow reuses the existing FollowButton /
 * follows API. Server-rendered; FollowButton is the only client leaf.
 */
export function WatchingModule({ items }: { items: WatchingItem[] }) {
  return (
    <section className="border border-rule bg-paper">
      <div className="flex items-baseline justify-between gap-4 border-b border-rule px-5 py-3.5">
        <h2 className="font-serif text-lg font-semibold text-ink">Watching</h2>
        <span className="font-mono text-[11px] text-ink-soft">
          {items.length} {items.length === 1 ? "follow" : "follows"}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-soft">
          You&rsquo;re not following anyone yet. Follow officials, agencies, and jurisdictions to
          track their activity.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {items.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="inline-flex shrink-0 items-center border border-rule px-1.5 py-[3px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-soft">
                  {f.chip}
                </span>
                <a
                  href={f.href}
                  className="min-w-0 truncate text-sm font-medium text-ink transition-colors hover:text-accent"
                >
                  {f.label}
                </a>
              </div>
              <FollowButton entityType={f.entity_type} entityId={f.entity_id} entityLabel={f.label} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
