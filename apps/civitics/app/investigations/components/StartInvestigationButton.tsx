"use client";

// Investigations MVP PR2 (FIX-579) — the "Start an investigation" affordance.
// ANY authenticated user may create; the per-user open cap + daily cap live in
// create_investigation (PR1) and surface here as a friendly 429. We never hide the
// button — we explain the cap (design decision 6).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { challengedFetch } from "@/lib/challenged-fetch";

function redirectToSignIn(next: string) {
  window.location.href = `/auth/sign-in?next=${encodeURIComponent(next)}`;
}

export function StartInvestigationButton({
  signedIn,
  openCount,
  cap,
  signInNext,
}: {
  signedIn: boolean;
  openCount: number;
  cap: number;
  signInNext: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [scopeNote, setScopeNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const atCap = signedIn && openCount >= cap;

  function openModal() {
    if (!signedIn) {
      redirectToSignIn(signInNext);
      return;
    }
    setError(null);
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (title.trim().length < 3) {
      setError("Title must be at least 3 characters.");
      return;
    }
    setSaving(true);
    try {
      const res = await challengedFetch("/api/investigations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          question: question.trim() || undefined,
          scope_note: scopeNote.trim() || undefined,
        }),
      });
      if (res.status === 401) {
        redirectToSignIn(signInNext);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok) {
        setError(
          res.status === 429
            ? data.error ?? `You're at the cap of ${cap} open investigations. Close one to start another.`
            : data.error ?? "Couldn't start the investigation. Try again.",
        );
        return;
      }
      if (data.id) {
        router.push(`/investigations/${data.id}`);
      } else {
        router.refresh();
        setOpen(false);
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
      >
        Start an investigation
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Start an investigation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <form
            onSubmit={submit}
            className="mt-8 w-full max-w-lg rounded-lg border border-rule bg-paper p-6 shadow-lg"
          >
            <h2 className="font-serif text-xl text-ink">Start an investigation</h2>
            <p className="mt-1 text-xs text-ink-soft">
              Open a case file. You can add cited evidence once it exists.
            </p>

            {atCap && (
              <p className="mt-3 rounded border border-amber/60 bg-amber/15 px-3 py-2 text-xs text-ink">
                You already have {openCount} open investigations (cap {cap}). You can still try — the
                server will confirm.
              </p>
            )}

            <label className="mt-4 block text-sm font-medium text-ink" htmlFor="inv-title">
              Title <span className="text-accent">*</span>
            </label>
            <input
              id="inv-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              autoFocus
              placeholder="e.g. Who funds the committee chairs blocking the rail bill?"
              className="mt-1 w-full rounded border border-rule bg-card px-3 py-2 text-sm text-ink focus:border-civic-blue focus:outline-none"
            />

            <label className="mt-4 block text-sm font-medium text-ink" htmlFor="inv-question">
              Investigative question
            </label>
            <textarea
              id="inv-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="What, specifically, are you trying to establish?"
              className="mt-1 w-full rounded border border-rule bg-card px-3 py-2 text-sm text-ink focus:border-civic-blue focus:outline-none"
            />

            <label className="mt-4 block text-sm font-medium text-ink" htmlFor="inv-scope">
              Scope note
            </label>
            <input
              id="inv-scope"
              value={scopeNote}
              onChange={(e) => setScopeNote(e.target.value)}
              maxLength={2000}
              placeholder="Jurisdiction, time window, or entities this concerns"
              className="mt-1 w-full rounded border border-rule bg-card px-3 py-2 text-sm text-ink focus:border-civic-blue focus:outline-none"
            />

            {error && <p className="mt-3 text-sm text-accent">{error}</p>}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-ink-soft hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
              >
                {saving ? "Starting…" : "Start"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
