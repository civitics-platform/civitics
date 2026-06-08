"use client";

// @deprecated (C0 / FIX-521) — superseded by the unified EntityComments
// component over the entity_comments substrate. No longer imported by the
// official detail page. Left in place per the no-delete rule; remove in a
// later cleanup PR.

import { useState, useEffect, useCallback, type FormEvent } from "react";
import { FlagButton } from "../../../components/FlagButton";

// ─── Types ────────────────────────────────────────────────────────────────────

type Comment = {
  id: string;
  body: string;
  created_at: string;
  upvotes: number;
  user_id: string;
  is_deleted: boolean;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(isoString: string): string {
  const now = new Date();
  const date = new Date(isoString);
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${diffYear}y ago`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface OfficialCommentsProps {
  officialId: string;
}

// QWEN-ADDED: Community comment section for official profile pages
export function OfficialComments({ officialId }: OfficialCommentsProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newComment, setNewComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [requiresAuth, setRequiresAuth] = useState(false);

  const fetchComments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/officials/${officialId}/comments`);
      if (!res.ok) {
        throw new Error("Failed to fetch comments");
      }
      const data = await res.json();
      setComments(data.comments ?? []);
    } catch {
      setError("Unable to load comments.");
    } finally {
      setLoading(false);
    }
  }, [officialId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!newComment.trim() || posting) return;

    setPosting(true);
    setPostError(null);

    try {
      const res = await fetch(`/api/officials/${officialId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: newComment }),
      });

      if (res.status === 401) {
        setRequiresAuth(true);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error ?? "Failed to post comment");
      }

      const data = await res.json();
      setComments((prev) => [data.comment, ...prev]);
      setNewComment("");
    } catch (err) {
      setPostError(err instanceof Error ? err.message : "Failed to post comment");
    } finally {
      setPosting(false);
    }
  };

  const charCount = newComment.length;
  const showCharCounter = charCount > 1800;
  const isOverLimit = charCount > 2000;

  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Community Comments
      </h2>

      {/* ─── Comment form ─────────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} className="mb-6">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Share a thought about this official's record…"
            rows={4}
            maxLength={2000}
            className="w-full rounded border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 resize-y"
            disabled={posting}
          />
          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {showCharCounter && (
                <span className={`text-xs ${isOverLimit ? "text-red-600 font-medium" : "text-gray-400"}`}>
                  {charCount} / 2000
                </span>
              )}
            </div>
            <button
              type="submit"
              disabled={!newComment.trim() || posting || isOverLimit}
              className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {posting ? "Posting..." : "Add comment"}
            </button>
          </div>
          {requiresAuth && (
            <p className="mt-2 text-xs text-gray-500">
              <a href="/auth/sign-in" className="text-indigo-600 hover:underline">Sign in</a> to add a comment.
            </p>
          )}
          {postError && (
            <p className="mt-2 text-xs text-red-600">{postError}</p>
          )}
        </div>
      </form>

      {/* ─── Comments list ────────────────────────────────────────────── */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-lg border border-gray-200 bg-white p-4 animate-pulse">
              <div className="h-3 w-24 bg-gray-200 rounded mb-2" />
              <div className="h-3 w-full bg-gray-100 rounded mb-1" />
              <div className="h-3 w-3/4 bg-gray-100 rounded" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={fetchComments}
            className="mt-2 text-xs text-red-600 hover:text-red-800 underline"
          >
            Retry
          </button>
        </div>
      ) : comments.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center">
          <p className="text-sm text-gray-500">
            Be the first to comment on this official.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {comments.map((comment) => (
            <div
              key={comment.id}
              className="rounded-lg border border-gray-200 bg-white p-4"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-700">
                    Anonymous
                  </span>
                  <span className="text-xs text-gray-400">
                    {formatRelativeTime(comment.created_at)}
                  </span>
                </div>
                <FlagButton
                  contentType="official_community_comment"
                  contentId={comment.id}
                />
              </div>
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                {comment.body}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
