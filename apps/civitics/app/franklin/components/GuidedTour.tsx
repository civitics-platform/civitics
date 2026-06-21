"use client";

// FIX-A (A2): the "take the tour" guided overlay for /franklin. It is a stepped,
// narrated walkthrough that drives off the SAME resolved spine stops the page
// already builds for <StorySpine> — it re-authors and re-queries NOTHING. Adding
// or reordering a stop in spine.ts flows into the tour automatically (decision 8).
//
// Shape: intro → the N spine stops (one at a time) → outro. As the tour advances
// it smooth-scrolls the matching spine card into view and lightly highlights it,
// so the tour visibly walks the page rather than floating detached (decision 3).
//
// It is a real dialog (decision 5): role="dialog", focus-trapped, Esc closes,
// ←/→ navigate, focus + scroll position restored on close, and it honors
// prefers-reduced-motion (no smooth-scroll / no highlight transition).
//
// Paper-mode, narrative — no terminal panels. Demonstration framing preserved
// via SyntheticMark in the intro (decision 7). Display-only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ResolvedStop } from "./StorySpine";
import { SyntheticMark } from "../../components/integrity/Synthetic";

// Anchor ids the page assigns so intro/outro have somewhere to scroll. The page
// owns these ids; if a target is absent the step still narrates (decision 3).
export const TOUR_HERO_ANCHOR = "franklin-hero";
export const TOUR_FOOTER_ANCHOR = "franklin-explore";
export const tourStopAnchor = (id: string) => `tour-stop-${id}`;

const HIGHLIGHT = ["ring-2", "ring-accent", "ring-offset-2", "ring-offset-paper"];

type Step =
  | { kind: "intro" }
  | { kind: "stop"; stop: ResolvedStop }
  | { kind: "outro" };

const FOOTER_LINKS = [
  { label: "Officials", href: "/officials" },
  { label: "Proposals", href: "/proposals" },
  { label: "Investigations", href: "/investigations" },
];

export function GuidedTour({
  billLabel,
  billTitle,
  stops,
  onClose,
}: {
  billLabel: string;
  billTitle: string;
  stops: ResolvedStop[];
  onClose: () => void;
}) {
  const steps = useMemo<Step[]>(
    () => [
      { kind: "intro" },
      ...stops.map((stop) => ({ kind: "stop", stop }) as Step),
      { kind: "outro" },
    ],
    [stops]
  );

  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useRef(false);
  // Captured at mount, restored at unmount (decision 5).
  const restore = useRef<{ el: Element | null; scrollY: number }>({
    el: null,
    scrollY: 0,
  });
  const highlighted = useRef<HTMLElement | null>(null);

  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(steps.length - 1, i)),
    [steps.length]
  );
  const next = useCallback(() => setIndex((i) => clamp(i + 1)), [clamp]);
  const prev = useCallback(() => setIndex((i) => clamp(i - 1)), [clamp]);

  // ── Mount: capture restore state, detect reduced motion, focus the dialog ──
  useEffect(() => {
    restore.current = {
      el: document.activeElement,
      scrollY: window.scrollY,
    };
    reduceMotion.current =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    dialogRef.current?.focus();

    return () => {
      // Clear any lingering highlight, then restore focus + scroll.
      if (highlighted.current) highlighted.current.classList.remove(...HIGHLIGHT);
      const { el, scrollY } = restore.current;
      if (el instanceof HTMLElement) el.focus();
      window.scrollTo({ top: scrollY, behavior: "auto" });
    };
  }, []);

  // ── Step change: scroll the target into view + highlight it ──
  useEffect(() => {
    const step = steps[index]!;
    const targetId =
      step.kind === "intro"
        ? TOUR_HERO_ANCHOR
        : step.kind === "outro"
          ? TOUR_FOOTER_ANCHOR
          : tourStopAnchor(step.stop.id);
    const el = document.getElementById(targetId);

    if (highlighted.current && highlighted.current !== el) {
      highlighted.current.classList.remove(...HIGHLIGHT);
      highlighted.current = null;
    }
    if (!el) return; // graceful — the step still narrates (decision 3)

    const behavior: ScrollBehavior = reduceMotion.current ? "auto" : "smooth";
    const top = window.scrollY + el.getBoundingClientRect().top - 120;
    window.scrollTo({ top: Math.max(0, top), behavior });

    // Highlight only the live spine cards; the hero/footer anchors just scroll.
    if (step.kind === "stop") {
      el.classList.add(...HIGHLIGHT);
      highlighted.current = el;
    }
  }, [index, steps]);

  // ── Keyboard: Esc closes, ←/→ navigate, Tab is focus-trapped ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const focusable = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, next, prev]);

  const step = steps[index]!;
  const total = steps.length;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Guided tour — Follow ${billLabel}`}
      tabIndex={-1}
      className="fixed inset-x-0 bottom-0 z-50 mx-auto mb-4 w-[calc(100%-2rem)] max-w-2xl border border-rule bg-paper shadow-2xl outline-none sm:mb-6"
    >
      {/* Header: counter + close */}
      <div className="flex items-center gap-3 border-b border-rule px-5 py-2.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
          The tour
        </span>
        <SyntheticMark size="xs" />
        <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-soft/70">
          {index + 1} / {total}
        </span>
        <button
          onClick={onClose}
          aria-label="Close the tour"
          className="-mr-1.5 rounded p-1 text-ink-soft/70 transition-colors hover:bg-ink/5 hover:text-ink"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="px-5 py-4">
        {step.kind === "intro" && (
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-soft/70">
              A guided demonstration
            </p>
            <h2 className="mt-1.5 font-serif text-xl font-semibold leading-snug text-ink">
              Follow one bill, end to end.
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {billLabel} — {billTitle} — runs through every Civitics surface: the
              bill, the floor vote, the money behind it, the cited case files, the
              public debate, and the citizen response. This tour walks all six,
              one stop at a time. Everything here is AI-generated demonstration
              data, clearly labeled <SyntheticMark size="xs" /> — nothing counts
              toward real standing.
            </p>
          </div>
        )}

        {step.kind === "stop" && (
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
              {step.stop.kicker}
            </p>
            <p className="mt-1.5 font-serif text-xl font-semibold leading-snug text-ink">
              {step.stop.value}
            </p>
            {step.stop.detail && (
              <p className="mt-0.5 font-mono text-[11px] text-ink-soft/80">
                {step.stop.detail}
              </p>
            )}
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {step.stop.connective}
            </p>
            <Link
              href={step.stop.href}
              className="mt-3 inline-block font-mono text-[12px] text-accent hover:underline"
            >
              See it on the record →
            </Link>
          </div>
        )}

        {step.kind === "outro" && (
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-soft/70">
              That&apos;s the thread
            </p>
            <h2 className="mt-1.5 font-serif text-xl font-semibold leading-snug text-ink">
              You&apos;ve followed one bill through every surface.
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Franklin is a demonstration — but the surfaces are real. Now explore
              the actual record.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {FOOTER_LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="border border-rule px-3 py-1.5 font-mono text-[12px] text-accent transition-colors hover:border-accent"
                >
                  {l.label} →
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer nav */}
      <div className="flex items-center gap-3 border-t border-rule px-5 py-3">
        <button
          onClick={prev}
          disabled={index === 0}
          className="font-mono text-[12px] text-ink-soft transition-colors enabled:hover:text-ink disabled:opacity-30"
        >
          ← Back
        </button>
        <div className="ml-auto flex items-center gap-2">
          {index < total - 1 ? (
            <button
              onClick={next}
              className="border border-accent bg-accent/10 px-4 py-1.5 font-mono text-[12px] font-semibold text-accent transition-colors hover:bg-accent hover:text-paper"
            >
              Next →
            </button>
          ) : (
            <button
              onClick={onClose}
              className="border border-accent bg-accent/10 px-4 py-1.5 font-mono text-[12px] font-semibold text-accent transition-colors hover:bg-accent hover:text-paper"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
