"use client";

import { useState, useEffect } from "react";

export interface CollapsiblePanelProps {
  /** Unique key — drives localStorage persistence */
  id: string;
  label: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * A sidebar panel that collapses/expands with localStorage persistence.
 * State is stored under key `panel_<id>`.
 */
export function CollapsiblePanel({
  id,
  label,
  icon,
  defaultOpen = false,
  children,
}: CollapsiblePanelProps) {
  const storageKey = `panel_${id}`;

  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultOpen;
    const saved = localStorage.getItem(storageKey);
    return saved !== null ? saved === "true" : defaultOpen;
  });

  // Sync on mount in case server/client differ
  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) setOpen(saved === "true");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      localStorage.setItem(storageKey, String(next));
      return next;
    });
  }

  return (
    <div className="border-b border-rule last:border-b-0">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-ink/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-ink-soft w-4 h-4 flex items-center justify-center shrink-0">
            {icon}
          </span>
          <span className="text-xs font-medium text-ink">{label}</span>
        </div>
        <svg
          className={`w-3 h-3 text-ink-soft/60 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1">
          {children}
        </div>
      )}
    </div>
  );
}
