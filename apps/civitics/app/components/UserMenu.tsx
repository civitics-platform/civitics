"use client";

import { useEffect, useRef, useState } from "react";
import { createBrowserClient } from "@civitics/db";
import type { User } from "@supabase/supabase-js";

interface UserMenuProps {
  user: User;
  onClose: () => void;
}

const PHASE2_ITEMS = ["My Positions", "Following", "Submitted Comments"];

export function UserMenu({ user, onClose }: UserMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [comingSoon, setComingSoon] = useState<string | null>(null);

  // Close on click outside
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function handleSignOut() {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    onClose();
    window.location.href = "/";
  }

  function initials(email: string) {
    return email.slice(0, 2).toUpperCase();
  }

  return (
    <div
      ref={menuRef}
      className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
    >
      {/* User header */}
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
          {initials(user.email ?? "?")}
        </div>
        <p className="truncate text-xs text-gray-600">{user.email}</p>
      </div>

      {/* Phase 2 items — shown as coming soon */}
      <div className="border-b border-gray-100 py-1">
        {PHASE2_ITEMS.map((item) => (
          <button
            key={item}
            onClick={() =>
              setComingSoon(comingSoon === item ? null : item)
            }
            className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            <span>{item}</span>
            {comingSoon === item ? (
              <span className="text-xs text-gray-400">Coming soon</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Platform dashboard */}
      <div className="border-b border-gray-100 py-1">
        <a
          href="/dashboard"
          onClick={onClose}
          className="flex w-full items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Platform Dashboard
          <span className="ml-1 text-gray-400">→</span>
        </a>
      </div>

      {/* Sign out */}
      <div className="py-1">
        <button
          onClick={handleSignOut}
          className="flex w-full items-center px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
