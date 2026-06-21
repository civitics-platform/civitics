"use client";

// FIX-A (A2): client island that lets the server-rendered /franklin hero (and an
// optional secondary affordance) open the GuidedTour. Click-launched only — never
// auto-opens (decision 4): a demo page that hijacks the viewport on load is
// intrusive. Holds the open-state and mounts <GuidedTour> only while open, so the
// dialog's mount/unmount drives focus + scroll capture/restore.
import { useState } from "react";
import { GuidedTour } from "./GuidedTour";
import type { ResolvedStop } from "./StorySpine";

export function TourLauncher({
  billLabel,
  billTitle,
  stops,
  label = "Start the tour",
  className,
}: {
  billLabel: string;
  billTitle: string;
  stops: ResolvedStop[];
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (stops.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "inline-flex items-center gap-2 border border-accent bg-accent/10 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-accent transition-colors hover:bg-accent hover:text-paper"
        }
      >
        {label} →
      </button>
      {open && (
        <GuidedTour
          billLabel={billLabel}
          billTitle={billTitle}
          stops={stops}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
