"use client";

/**
 * FIX-401 — "Flag this data": a reader's flag on a data row, beside the
 * SourceBadge on the detail pages and in the explorer's detail rail.
 *
 * It fetches nothing on render, so the ISR pages it sits on stay cacheable and
 * no per-viewer state enters their payload. The one request is the POST on
 * submit. It renders whether or not the page has an attribution (the badge
 * renders nothing then; this still does). Nothing about other readers' flags
 * is ever shown — the flagger sees only their own confirmation.
 */

import { useId, useState } from "react";
import type { AttributionEntityType } from "@civitics/db";
import { DATA_FLAG_COMMENT_MAX, DATA_FLAG_REASONS, DATA_FLAG_REASON_LABELS } from "@/lib/data-flags";

interface FlagDataButtonProps {
  entityType: AttributionEntityType;
  entityId: string;
  /** The attribution's primary source key, when one is in scope. */
  source?: string | null;
  /** "popover" floats over the header row; "inline" opens in flow (scrolling rails clip a popover). */
  variant?: "popover" | "inline";
}

export function FlagDataButton({ entityType, entityId, source, variant = "popover" }: FlagDataButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("wrong");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const panelId = useId();

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/data-flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id:   entityId,
          reason,
          comment: comment.trim() || undefined,
          source:  source || undefined,
        }),
      });
      if (res.status === 401) {
        setNeedsAuth(true);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to flag");
      }
      setDone(true);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to flag");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <span className="text-[11px] text-ink-soft/70" aria-live="polite">
        Flagged · thanks, we&apos;ll take a look
      </span>
    );
  }

  const panelClass =
    variant === "inline"
      ? "mt-2 w-full border border-rule bg-card p-3"
      : "absolute left-0 top-6 z-20 w-64 max-w-[calc(100vw-2rem)] border border-rule bg-card p-3 shadow-lg";

  return (
    <div className={variant === "inline" ? "block" : "relative inline-block"}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-ink-soft/70 hover:text-accent transition-colors"
        aria-expanded={open}
        aria-controls={panelId}
      >
        ⚑ Flag this data
      </button>

      {open && (
        <div id={panelId} className={panelClass}>
          <label className="block text-[11px] font-medium text-ink-soft">
            What&apos;s the problem?
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded border border-rule bg-card px-2 py-1 text-xs font-normal text-ink"
            >
              {DATA_FLAG_REASONS.map((r) => (
                <option key={r} value={r}>
                  {DATA_FLAG_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-2 block text-[11px] font-medium text-ink-soft">
            Add detail (optional)
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              maxLength={DATA_FLAG_COMMENT_MAX}
              className="mt-1 w-full rounded border border-rule bg-card px-2 py-1 text-xs font-normal text-ink resize-none"
            />
          </label>

          {needsAuth && (
            <p className="mt-2 text-[11px] text-accent">
              <a href="/auth/sign-in" className="underline">Sign in to flag</a> this data.
            </p>
          )}
          {error && !needsAuth && (
            <p className="mt-2 text-[11px] text-accent" role="alert">{error}</p>
          )}

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded border border-rule px-2 py-1 text-[11px] text-ink-soft hover:bg-paper-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent disabled:opacity-50"
            >
              {busy ? "…" : "Send flag"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
