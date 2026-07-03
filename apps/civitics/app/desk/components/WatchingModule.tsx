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
 * entity-label resolver (FIX-597), rendered as an embedded terminal instrument
 * (FIX-A): the data-theme="terminal" wrapper re-binds the semantic tokens so
 * the panel reads dark inside the paper desk, mirroring the ClosingSoonPanel
 * chrome. Unfollow reuses the existing FollowButton / follows API — FollowButton
 * is fully token-native, so it re-binds to dark under the wrapper with no change.
 * Server-rendered; FollowButton is the only client leaf.
 */
export function WatchingModule({ items }: { items: WatchingItem[] }) {
  return (
    <section
      data-theme="terminal"
      className="overflow-hidden rounded-[10px] border border-term-line bg-term-bg text-term-txt shadow-[0_14px_34px_rgba(28,26,22,0.18)]"
    >
      <div className="flex items-center justify-between gap-4 border-b border-term-line bg-term-panel px-4 py-3">
        <span className="font-mono text-[11.5px] font-bold uppercase tracking-[0.16em]">
          <span className="mr-2 text-amber">●</span>Watching
        </span>
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] tabular-nums text-term-dim">
          {items.length} {items.length === 1 ? "follow" : "follows"}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-term-dim">
          You&rsquo;re not following anyone yet. Follow officials, agencies, and jurisdictions to
          track their activity.
        </p>
      ) : (
        <ul className="divide-y divide-term-line">
          {items.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="inline-flex shrink-0 items-center border border-term-line px-1.5 py-[3px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-term-faint">
                  {f.chip}
                </span>
                <a
                  href={f.href}
                  className="min-w-0 truncate text-sm font-medium text-term-txt transition-colors hover:text-amber"
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
