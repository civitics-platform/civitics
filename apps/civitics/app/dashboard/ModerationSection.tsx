"use client";

import { useCallback, useEffect, useState } from "react";
import { useIsAdmin } from "@/lib/use-is-admin";

type Flag = {
  id: string;
  content_type: "civic_comment" | "official_community_comment";
  content_id: string;
  user_id: string;
  reason: string;
  note: string | null;
  resolved: boolean;
  created_at: string;
  content: {
    body: string;
    user_id: string;
    is_deleted: boolean;
    proposal_id?: string | null;
    official_id?: string | null;
  } | null;
};

const REASON_LABELS: Record<string, string> = {
  spam:           "Spam",
  harassment:     "Harassment",
  off_topic:      "Off-topic",
  misinformation: "Misinformation",
  other:          "Other",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day:   "numeric",
    hour:  "numeric",
    minute:"2-digit",
  });
}

function contextLink(flag: Flag): string | null {
  if (!flag.content) return null;
  if (flag.content_type === "civic_comment" && flag.content.proposal_id) {
    return `/proposals/${flag.content.proposal_id}`;
  }
  if (flag.content_type === "official_community_comment" && flag.content.official_id) {
    return `/officials/${flag.content.official_id}`;
  }
  return null;
}

export function ModerationSection() {
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"pending" | "resolved">("pending");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/moderation?resolved=${tab === "resolved" ? 1 : 0}`
      );
      if (res.status === 403) {
        setFlags([]);
        setError("admin");
        return;
      }
      if (!res.ok) throw new Error("Failed to load flags");
      const data = await res.json();
      setFlags(data.flags ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setFlags([]);
    }
  }, [tab, isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  if (adminLoading) return null;
  if (!isAdmin) return null;

  const act = async (flagId: string, action: "dismiss" | "delete") => {
    setBusy(flagId);
    try {
      const res = await fetch("/api/admin/moderation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag_id: flagId, action }),
      });
      if (res.ok) {
        setFlags((prev) => (prev ? prev.filter((f) => f.id !== flagId) : prev));
      }
    } finally {
      setBusy(null);
    }
  };

  if (error === "admin") return null;

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Content Moderation</h2>
          <p className="text-xs text-gray-400">
            User-reported comments. Admin-only.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 p-1">
          <button
            type="button"
            onClick={() => setTab("pending")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              tab === "pending"
                ? "bg-indigo-600 text-white"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Pending
          </button>
          <button
            type="button"
            onClick={() => setTab("resolved")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              tab === "resolved"
                ? "bg-indigo-600 text-white"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Resolved
          </button>
        </div>
      </div>

      {flags === null ? (
        <div className="text-xs text-gray-400">Loading…</div>
      ) : flags.length === 0 ? (
        <div className="text-xs text-gray-400 py-4 text-center">
          {tab === "pending" ? "No pending flags." : "No resolved flags yet."}
        </div>
      ) : (
        <ul className="space-y-3">
          {flags.map((f) => {
            const link = contextLink(f);
            const body = f.content?.body ?? "(content unavailable)";
            return (
              <li
                key={f.id}
                className="rounded-lg border border-gray-200 bg-gray-50 p-3"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                      {REASON_LABELS[f.reason] ?? f.reason}
                    </span>
                    <span className="text-[10px] text-gray-500">
                      {f.content_type === "civic_comment"
                        ? "Proposal comment"
                        : "Official comment"}
                    </span>
                    <span className="text-[10px] text-gray-400">
                      {formatDate(f.created_at)}
                    </span>
                    {f.content?.is_deleted && (
                      <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
                        already deleted
                      </span>
                    )}
                  </div>
                  {link && (
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-indigo-600 hover:underline"
                    >
                      open context ↗
                    </a>
                  )}
                </div>

                <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                  {body}
                </p>

                {f.note && (
                  <p className="mt-2 text-[11px] text-gray-500 italic">
                    Reporter note: {f.note}
                  </p>
                )}

                {!f.resolved && (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => act(f.id, "dismiss")}
                      disabled={busy === f.id}
                      className="rounded border border-gray-300 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      onClick={() => act(f.id, "delete")}
                      disabled={busy === f.id || f.content?.is_deleted}
                      className="rounded bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {busy === f.id ? "…" : "Delete comment"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
