"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface InlineEditorProps {
  initiativeId: string;
  currentTitle: string;
  currentSummary: string | null;
  currentBody: string;
  currentScope: string;
  currentTags: string[];
}

const ISSUE_TAG_OPTIONS = [
  "climate", "healthcare", "education", "housing", "immigration", "finance",
  "energy", "agriculture", "transportation", "labor", "civil_rights",
  "foreign_policy", "criminal_justice", "technology", "consumer_protection",
];

export function InlineEditor({
  initiativeId,
  currentTitle,
  currentSummary,
  currentBody,
  currentScope,
  currentTags,
}: InlineEditorProps) {
  const router = useRouter();
  const [editing, setEditing]   = useState(false);
  const [title, setTitle]       = useState(currentTitle);
  const [summary, setSummary]   = useState(currentSummary ?? "");
  const [bodyMd, setBodyMd]     = useState(currentBody);
  const [scope, setScope]       = useState(currentScope);
  const [tags, setTags]         = useState<string[]>(currentTags);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);

  function toggleTag(tag: string) {
    setTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (title.trim().length < 10) { setError("Title must be at least 10 characters."); return; }
    if (title.trim().length > 120) { setError("Title must be 120 characters or fewer."); return; }
    if (bodyMd.trim().length === 0) { setError("Proposal body is required."); return; }

    setSaving(true);
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          summary: summary.trim() || null,
          body_md: bodyMd.trim(),
          scope,
          issue_area_tags: tags,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save changes.");
        setSaving(false);
        return;
      }

      setEditing(false);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex items-center gap-1.5 rounded-lg border border-rule bg-card px-3 py-1.5 text-xs font-medium text-ink-soft shadow-sm hover:border-rule hover:text-ink transition-colors"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        Edit
      </button>
    );
  }

  return (
    // QWEN-ADDED: absolute positioning to avoid layout collision with title/sidebar
    <form onSubmit={handleSave} className="absolute right-0 top-8 z-20 w-[min(560px,calc(100vw-2rem))] space-y-5 rounded-xl border border-accent bg-card shadow-xl p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-accent">Editing draft</span>
        <button
          type="button"
          onClick={() => { setEditing(false); setError(null); }}
          className="text-xs text-accent hover:text-accent"
        >
          Cancel
        </button>
      </div>

      {/* Title */}
      <div>
        <label className="block text-xs font-semibold text-ink-soft mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          className="block w-full rounded-lg border border-rule bg-card px-3 py-2 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Summary */}
      <div>
        <label className="block text-xs font-semibold text-ink-soft mb-1">Summary (optional)</label>
        <textarea
          rows={2}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={500}
          className="block w-full rounded-lg border border-rule bg-card px-3 py-2 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-none"
        />
      </div>

      {/* Body */}
      <div>
        <label className="block text-xs font-semibold text-ink-soft mb-1">Proposal</label>
        <textarea
          rows={12}
          value={bodyMd}
          onChange={(e) => setBodyMd(e.target.value)}
          className="block w-full rounded-lg border border-rule bg-card px-3 py-2 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono"
        />
      </div>

      {/* Scope */}
      <div>
        <label className="block text-xs font-semibold text-ink-soft mb-1">Scope</label>
        <div className="flex gap-2">
          {(["federal", "state", "local"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                scope === s
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-rule bg-card text-ink-soft hover:border-rule"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Tags */}
      <div>
        <label className="block text-xs font-semibold text-ink-soft mb-1">Issue areas</label>
        <div className="flex flex-wrap gap-1.5">
          {ISSUE_TAG_OPTIONS.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              className={`rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors ${
                tags.includes(tag)
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-rule bg-card text-ink-soft"
              }`}
            >
              {tag.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-accent/25 bg-accent/10 px-4 py-2.5 text-xs text-accent">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={() => { setEditing(false); setError(null); }}
          className="rounded-lg border border-rule bg-card px-4 py-2 text-sm text-ink-soft hover:bg-paper-2"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}