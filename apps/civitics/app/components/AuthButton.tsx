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
      <div className="h-8 w-16 animate-pulse rounded-md bg-gray-100" />
    );
  }

  // Signed in — show avatar + dropdown
  if (user) {
    const initials = (user.email ?? "?").slice(0, 2).toUpperCase();
    return (
      <div className="relative" ref={avatarRef}>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700 hover:bg-indigo-200 transition-colors"
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
        onClick={() => setModalOpen(true)}
        className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
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
