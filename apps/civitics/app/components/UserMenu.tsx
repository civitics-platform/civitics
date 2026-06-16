"use client";

import { useEffect, useRef, useState } from "react";
import { createBrowserClient } from "@civitics/db";
import type { User } from "@supabase/supabase-js";

interface UserMenuProps {
  user: User;
  onClose: () => void;
}

// Phase 1 — real working links
const PHASE1_LINKS = [
  { label: "My Desk",        href: "/desk"               },
  { label: "My Initiatives", href: "/initiatives?mine=1" },
];

// Phase 2 — not built yet
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
      className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden border border-ink bg-card shadow-[0_14px_30px_rgba(28,26,22,0.18)]"
    >
      {/* User header */}
      <div className="flex items-center gap-2.5 border-b border-rule px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-rule bg-paper-2 text-xs font-semibold text-ink">
          {initials(user.email ?? "?")}
        </div>
        <p className="truncate font-mono text-[11px] text-ink-soft">{user.email}</p>
      </div>

      {/* Phase 1 links — live */}
      <div className="border-b border-rule py-1">
        {PHASE1_LINKS.map(({ label, href }) => (
          <a
            key={href}
            href={href}
            onClick={onClose}
            className="flex w-full items-center px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-2 hover:text-accent"
          >
            {label}
          </a>
        ))}
      </div>

      {/* Phase 2 items — shown as coming soon */}
      <div className="border-b border-rule py-1">
        {PHASE2_ITEMS.map((item) => (
          <button
            key={item}
            onClick={() => setComingSoon(comingSoon === item ? null : item)}
            className="flex w-full items-center justify-between px-4 py-2 text-left text-sm font-medium text-ink transition-colors hover:bg-paper-2 hover:text-accent"
          >
            <span>{item}</span>
            {comingSoon === item && (
              <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-soft">Coming soon</span>
            )}
          </button>
        ))}
      </div>

      {/* Platform dashboard */}
      <div className="border-b border-rule py-1">
        <a
          href="/dashboard"
          onClick={onClose}
          className="flex w-full items-center px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-2 hover:text-accent"
        >
          Platform Dashboard
          <span className="ml-1 text-accent">→</span>
        </a>
      </div>

      {/* Sign out */}
      <div className="py-1">
        <button
          onClick={handleSignOut}
          className="flex w-full items-center px-4 py-2 text-left text-sm font-medium text-ink transition-colors hover:bg-paper-2 hover:text-accent"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
