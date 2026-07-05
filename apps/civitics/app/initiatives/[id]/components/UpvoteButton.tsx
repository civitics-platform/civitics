"use client";

import { useState, useEffect } from "react";

interface UpvoteButtonProps {
  initiativeId: string;
  initialCount: number;
}

export function UpvoteButton({ initiativeId, initialCount }: UpvoteButtonProps) {
  const [count, setCount]     = useState(initialCount);
  const [upvoted, setUpvoted] = useState(false);
  const [loading, setLoading] = useState(false);

  // Check if current user has already upvoted
  useEffect(() => {
    fetch(`/api/initiatives/${initiativeId}/upvote`)
      .then((r) => r.json())
      .then((d) => setUpvoted(d.upvoted ?? false))
      .catch(() => {/* ignore */});
  }, [initiativeId]);

  async function toggle() {
    if (loading) return;
    setLoading(true);

    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/upvote`, {
        method: "POST",
      });

      if (res.status === 401) {
        window.location.href = `/auth/sign-in?next=/initiatives/${initiativeId}`;
        return;
      }

      const data = await res.json();
      if (res.ok) {
        setUpvoted(data.upvoted);
        setCount(data.count);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={loading}
      className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-all disabled:opacity-60 ${
        upvoted
          ? "border-accent bg-accent/10 text-accent hover:bg-accent/10"
          : "border-rule bg-card text-ink-soft hover:border-accent hover:bg-accent/10 hover:text-accent"
      }`}
    >
      <svg
        className={`h-4 w-4 transition-transform ${upvoted ? "scale-110" : ""}`}
        viewBox="0 0 20 20"
        fill={upvoted ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l5-5 5 5M5 9l5-5 5 5" />
      </svg>
      <span>{count.toLocaleString()}</span>
      <span className="font-normal">{upvoted ? "supported" : "support this"}</span>
    </button>
  );
}
