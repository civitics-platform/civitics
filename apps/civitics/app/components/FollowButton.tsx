"use client";

import { useCallback, useEffect, useState } from "react";

type EntityType = "official" | "agency" | "jurisdiction";

interface FollowButtonProps {
  entityType: EntityType;
  entityId: string;
  entityLabel?: string;
}

export function FollowButton({ entityType, entityId, entityLabel }: FollowButtonProps) {
  const [following, setFollowing] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/follows?entity_type=${entityType}&entity_id=${entityId}`
      );
      if (res.status === 401) {
        setFollowing(false);
        return;
      }
      if (!res.ok) {
        setFollowing(false);
        return;
      }
      const data = await res.json();
      setFollowing(!!data.following);
    } catch {
      setFollowing(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setNeedsAuth(false);
    try {
      if (following) {
        const res = await fetch(
          `/api/follows?entity_type=${entityType}&entity_id=${entityId}`,
          { method: "DELETE" }
        );
        if (res.status === 401) {
          setNeedsAuth(true);
          return;
        }
        if (res.ok) setFollowing(false);
      } else {
        const res = await fetch("/api/follows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity_type: entityType, entity_id: entityId }),
        });
        if (res.status === 401) {
          setNeedsAuth(true);
          return;
        }
        if (res.ok) setFollowing(true);
      }
    } finally {
      setBusy(false);
    }
  };

  if (following === null) {
    return (
      <span className="inline-block h-7 w-20 animate-pulse rounded-lg bg-gray-100" />
    );
  }

  const baseCls =
    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50";

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={following}
        aria-label={
          following
            ? `Unfollow ${entityLabel ?? "this entity"}`
            : `Follow ${entityLabel ?? "this entity"}`
        }
        className={
          following
            ? `${baseCls} border border-gray-200 bg-white text-gray-700 hover:bg-gray-50`
            : `${baseCls} bg-indigo-600 text-white hover:bg-indigo-700`
        }
      >
        <span>{following ? "✓" : "+"}</span>
        {busy ? "…" : following ? "Following" : "Follow"}
      </button>
      {needsAuth && (
        <a
          href="/auth/sign-in"
          className="text-[10px] text-indigo-600 hover:underline"
        >
          Sign in to follow
        </a>
      )}
    </div>
  );
}
