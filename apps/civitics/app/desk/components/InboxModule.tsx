"use client";

import { useState } from "react";

export type InboxNotification = {
  id: string;
  title: string | null;
  body: string | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
};

function relDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Inbox — the Desk notifications module, rendered as an embedded terminal
 * instrument (FIX-A). The data-theme="terminal" wrapper re-binds the semantic
 * tokens so this panel reads dark inside the paper desk, mirroring the
 * homepage ClosingSoonPanel chrome (amber-dot header, term-line hairlines).
 * Newest-first; unread rows are accented. "Mark all read" calls the existing
 * POST /api/notifications { mark_all_read } (same contract NotificationsBell
 * uses) and flips local state optimistically.
 */
export function InboxModule({
  initial,
  initialUnread,
}: {
  initial: InboxNotification[];
  initialUnread: number;
}) {
  const [items, setItems] = useState(initial);
  const [unread, setUnread] = useState(initialUnread);
  const [busy, setBusy] = useState(false);

  async function markAllRead() {
    if (busy || unread === 0) return;
    setBusy(true);
    const prev = items;
    setItems(items.map((n) => ({ ...n, is_read: true })));
    setUnread(0);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mark_all_read: true }),
      });
      if (!res.ok) {
        setItems(prev);
        setUnread(initialUnread);
      }
    } catch {
      setItems(prev);
      setUnread(initialUnread);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-theme="terminal"
      className="overflow-hidden rounded-[10px] border border-term-line bg-term-bg text-term-txt shadow-[0_14px_34px_rgba(28,26,22,0.18)]"
    >
      <div className="flex items-center justify-between gap-4 border-b border-term-line bg-term-panel px-4 py-3">
        <span className="font-mono text-[11.5px] font-bold uppercase tracking-[0.16em]">
          <span className="mr-2 text-amber">●</span>Inbox
        </span>
        <div className="flex items-center gap-3">
          {unread > 0 && (
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] tabular-nums text-amber">
              {unread} unread
            </span>
          )}
          {unread > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              disabled={busy}
              className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-term-dim transition-colors hover:text-term-txt disabled:opacity-50"
            >
              {busy ? "…" : "Mark all read"}
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-term-dim">
          No notifications yet. Follow officials, agencies, or jurisdictions to get updates here.
        </p>
      ) : (
        <ul className="divide-y divide-term-line">
          {items.map((n) => {
            const inner = (
              <>
                <div className="flex items-start gap-2">
                  {!n.is_read && (
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber"
                    />
                  )}
                  <div className="min-w-0">
                    {n.title && (
                      <p
                        className={`truncate text-sm ${
                          n.is_read ? "font-medium text-term-dim" : "font-semibold text-term-txt"
                        }`}
                      >
                        {n.title}
                      </p>
                    )}
                    {n.body && (
                      <p className="mt-0.5 line-clamp-2 text-sm text-term-dim">{n.body}</p>
                    )}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-term-faint">
                  {relDate(n.created_at)}
                </span>
              </>
            );
            return (
              <li key={n.id} className={n.is_read ? "" : "bg-term-panel"}>
                {n.link ? (
                  <a
                    href={n.link}
                    className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-term-panel"
                  >
                    {inner}
                  </a>
                ) : (
                  <div className="flex items-start justify-between gap-3 px-4 py-3">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
