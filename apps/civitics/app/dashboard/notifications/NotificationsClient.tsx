"use client";

import { useCallback, useEffect, useState } from "react";

type Notification = {
  id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  body: string | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
};

type Follow = {
  id: string;
  entity_type: "official" | "agency";
  entity_id: string;
  email_enabled: boolean;
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
  return `${d}d ago`;
}

export function NotificationsClient() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nRes, fRes] = await Promise.all([
        fetch("/api/notifications?limit=50"),
        fetch("/api/follows"),
      ]);
      if (nRes.ok) {
        const n = await nRes.json();
        setNotifications(n.notifications ?? []);
      }
      if (fRes.ok) {
        const f = await fRes.json();
        setFollows(f.follows ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const markAllRead = async () => {
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mark_all_read: true }),
    });
    setNotifications((p) => p.map((n) => ({ ...n, is_read: true })));
  };

  const unfollow = async (fo: Follow) => {
    await fetch(
      `/api/follows?entity_type=${fo.entity_type}&entity_id=${fo.entity_id}`,
      { method: "DELETE" }
    );
    setFollows((p) => p.filter((x) => x.id !== fo.id));
  };

  const toggleEmail = async (fo: Follow) => {
    const next = !fo.email_enabled;
    // Optimistic
    setFollows((p) =>
      p.map((x) => (x.id === fo.id ? { ...x, email_enabled: next } : x))
    );
    await fetch("/api/follows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity_type:   fo.entity_type,
        entity_id:     fo.entity_id,
        email_enabled: next,
      }),
    });
  };

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      {/* Notifications list */}
      <section className="border border-rule bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Recent activity</h2>
          {notifications.some((n) => !n.is_read) && (
            <button
              type="button"
              onClick={markAllRead}
              className="text-xs text-accent hover:underline"
            >
              Mark all read
            </button>
          )}
        </div>
        {loading ? (
          <p className="text-xs text-ink-soft">Loading…</p>
        ) : notifications.length === 0 ? (
          <p className="text-xs text-ink-soft py-4 text-center">
            No notifications yet. Follow officials or agencies to start receiving updates.
          </p>
        ) : (
          <ul className="space-y-2">
            {notifications.map((n) => (
              <li
                key={n.id}
                className={`border border-rule p-3 ${
                  n.is_read ? "bg-transparent" : "bg-accent/10"
                }`}
              >
                <p
                  className={`text-sm ${
                    n.is_read ? "text-ink-soft" : "font-medium text-ink"
                  }`}
                >
                  {n.title}
                </p>
                {n.body && <p className="mt-1 text-xs text-ink-soft">{n.body}</p>}
                <div className="mt-1 flex items-center gap-3">
                  <span className="text-[10px] text-ink-soft/70">
                    {formatRelative(n.created_at)}
                  </span>
                  {n.link && (
                    <a href={n.link} className="text-[11px] text-accent hover:underline">
                      Open →
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Following list */}
      <section className="border border-rule bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">You&apos;re following</h2>
        {loading ? (
          <p className="text-xs text-ink-soft">Loading…</p>
        ) : follows.length === 0 ? (
          <p className="text-xs text-ink-soft py-4 text-center">
            Not following anyone yet. Visit any official or agency to follow them.
          </p>
        ) : (
          <ul className="space-y-2">
            {follows.map((f) => {
              const url =
                f.entity_type === "official"
                  ? `/officials/${f.entity_id}`
                  : `/agencies/${f.entity_id}`;
              return (
                <li
                  key={f.id}
                  className="flex items-center justify-between border border-rule p-3"
                >
                  <div className="min-w-0 flex-1">
                    <a
                      href={url}
                      className="truncate text-sm font-medium text-ink hover:text-accent"
                    >
                      {f.entity_type === "official" ? "Official" : "Agency"}{" · "}
                      <span className="font-mono text-xs text-ink-soft">
                        {f.entity_id.slice(0, 8)}
                      </span>
                    </a>
                    <p className="text-[10px] text-ink-soft/70">
                      Following since {new Date(f.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1 text-[11px] text-ink-soft">
                      <input
                        type="checkbox"
                        checked={f.email_enabled}
                        onChange={() => toggleEmail(f)}
                        className="h-3 w-3"
                      />
                      Email
                    </label>
                    <button
                      type="button"
                      onClick={() => unfollow(f)}
                      className="text-[11px] text-accent hover:underline"
                    >
                      Unfollow
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
