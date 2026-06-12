"use client";

import { useEffect, useRef, useState } from "react";
import { createBrowserClient } from "@civitics/db";
import type { User } from "@supabase/supabase-js";
import { AuthModal } from "./AuthModal";
import { UserMenu } from "./UserMenu";

interface AuthButtonProps {
  /** Optional context for the sign-in modal trigger text */
  modalTrigger?: string;
}

export function AuthButton({ modalTrigger }: AuthButtonProps) {
  const [user, setUser] = useState<User | null>(null);
  const [mounted, setMounted] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    const supabase = createBrowserClient();

    // Get initial session
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user);
    });

    // Subscribe to auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        setModalOpen(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Don't render until client hydration (prevents SSR mismatch)
  if (!mounted) {
    return (
      <div className="h-8 w-16 animate-pulse rounded-md bg-paper-2" />
    );
  }

  // Signed in — show avatar + dropdown
  if (user) {
    const initials = (user.email ?? "?").slice(0, 2).toUpperCase();
    return (
      <div className="relative" ref={avatarRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="flex h-8 w-8 items-center justify-center rounded-full border-[1.5px] border-ink bg-card text-xs font-semibold text-ink hover:bg-paper-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
          aria-label="Account menu"
        >
          {initials}
        </button>

        {menuOpen && (
          <UserMenu user={user} onClose={() => setMenuOpen(false)} />
        )}
      </div>
    );
  }

  // Not signed in — show Sign in button
  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="border-[1.5px] border-ink bg-transparent px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink hover:bg-ink hover:text-paper transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
      >
        Sign in
      </button>

      <AuthModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        trigger={modalTrigger}
      />
    </>
  );
}
