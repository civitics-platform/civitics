"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Notification = {
  id: string;
  event_type: string;
  title: string;
  body: string | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=20");
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setAuthed(true);
      setItems(data.notifications ?? []);
      setUnread(data.unread_count ?? 0);
    } catch {
      // swallow — bell silently hides on transient errors
    }
  }, []);

  useEffect(() => {
    load();
    const int = setInterval(load, 60_000);
    return () => clearInterval(int);
  }, [load]);

  // Close when clicking outside
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const markAllRead = async () => {
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mark_all_read: true }),
    });
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnread(0);
  };

  const onItemClick = async (n: Notification) => {
    if (!n.is_read) {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [n.id] }),
      });
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
    }
    if (n.link) {
      window.location.href = n.link;
    }
  };

  // Don't render for signed-out users.
  if (authed === false) return null;
  if (authed === null) return null;

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        aria-expanded={open}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-paper-2 hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-5-5.9V4a1 1 0 10-2 0v1.1A6 6 0 006 11v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1 right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-mono text-[9px] font-bold text-paper">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 border border-ink bg-card shadow-[0_14px_30px_rgba(28,26,22,0.18)]">
          <div className="flex items-center justify-between border-b border-rule px-3 py-2">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-accent">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-[11px] font-medium text-accent hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-ink-soft">
                No notifications yet. Follow officials and agencies to start getting updates.
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onItemClick(n)}
                  className="block w-full border-b border-rule px-3 py-2 text-left text-xs hover:bg-paper-2 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    {!n.is_read && (
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p
                        className={`truncate ${
                          n.is_read ? "text-ink-soft" : "font-medium text-ink"
                        }`}
                      >
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="mt-0.5 truncate text-[11px] text-ink-soft">{n.body}</p>
                      )}
                      <p className="mt-0.5 font-mono text-[10px] text-ink-soft">
                        {formatRelative(n.created_at)}
                      </p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
          <a
            href="/dashboard/notifications"
            className="block border-t border-rule px-3 py-2 text-center font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-accent transition-colors hover:bg-paper-2"
          >
            View all & manage follows →
          </a>
        </div>
      )}
    </div>
  );
}
