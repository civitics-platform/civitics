"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// ─── Constants ────────────────────────────────────────────────────────────────

type Scope = "federal" | "state" | "local";

const SCOPE_OPTIONS: { value: Scope; label: string; description: string }[] = [
  { value: "federal",  label: "Federal",  description: "Congress, federal agencies, or the President" },
  { value: "state",    label: "State",    description: "State legislature or governor" },
  { value: "local",    label: "Local",    description: "City, county, or district officials" },
];

const ISSUE_TAG_OPTIONS = [
  "climate", "healthcare", "education", "housing", "immigration", "finance",
  "energy", "agriculture", "transportation", "labor", "civil_rights",
  "foreign_policy", "criminal_justice", "technology", "consumer_protection",
];

// ─── Component ────────────────────────────────────────────────────────────────

export function PostProblemForm() {
  const router = useRouter();

  const [title, setTitle]               = useState("");
  const [description, setDescription]   = useState("");
  const [scope, setScope]               = useState<Scope>("federal");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);

  function toggleTag(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (title.trim().length < 10) {
      setError("Problem statement must be at least 10 characters.");
      return;
    }
    if (title.trim().length > 120) {
      setError("Problem statement must be 120 characters or fewer.");
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/initiatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          summary: description.trim() || undefined,
          body_md: description.trim(),  // store description in body_md; author can expand later
          scope,
          issue_area_tags: selectedTags,
          is_problem: true,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to post problem.");
        setSubmitting(false);
        return;
      }

      router.push(`/initiatives/${data.initiative.id}`);
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  const titleLen = title.length;

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* ── What's the problem? ──────────────────────────────────────── */}
      <div>
        <label htmlFor="title" className="block text-sm font-semibold text-ink">
          What&apos;s the problem? <span className="text-accent">*</span>
        </label>
        <p className="mt-0.5 text-xs text-ink-soft/70">
          State the problem clearly and specifically. (10–120 characters)
        </p>
        <div className="relative mt-2">
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder="e.g. Federal campaign finance disclosures take weeks to appear publicly"
            className="block w-full rounded-lg border border-rule bg-card px-4 py-2.5 text-sm text-ink shadow-sm placeholder:text-ink-soft/70 focus:border-amber/60 focus:outline-none focus:ring-1 focus:ring-amber/60"
            autoFocus
          />
          <span
            className={`absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums ${
              titleLen > 0 && (titleLen < 10 || titleLen > 120) ? "text-accent" : "text-ink-soft/70"
            }`}
          >
            {titleLen}/120
          </span>
        </div>
      </div>

      {/* ── More context ─────────────────────────────────────────────── */}
      <div>
        <label htmlFor="description" className="block text-sm font-semibold text-ink">
          More context <span className="text-ink-soft/70 font-normal">(optional)</span>
        </label>
        <p className="mt-0.5 text-xs text-ink-soft/70">
          Who is affected? How does it happen? Any data or examples? You don&apos;t need a solution yet.
        </p>
        <textarea
          id="description"
          rows={6}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          placeholder={`Describe the problem in more detail...\n\nWho does it affect? Under what circumstances? What evidence exists? What have previous efforts to address it achieved?`}
          className="mt-2 block w-full rounded-lg border border-rule bg-card px-4 py-3 text-sm text-ink shadow-sm placeholder:text-ink-soft/70 focus:border-amber/60 focus:outline-none focus:ring-1 focus:ring-amber/60 resize-y"
        />
      </div>

      {/* ── Scope ────────────────────────────────────────────────────── */}
      <div>
        <label className="block text-sm font-semibold text-ink">
          Scope <span className="text-accent">*</span>
        </label>
        <p className="mt-0.5 text-xs text-ink-soft/70">Which level of government is most relevant?</p>
        <div className="mt-2 grid grid-cols-3 gap-3">
          {SCOPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setScope(opt.value)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                scope === opt.value
                  ? "border-amber/60 bg-amber/20"
                  : "border-rule bg-card hover:border-rule"
              }`}
            >
              <div className={`text-sm font-semibold ${scope === opt.value ? "text-ink" : "text-ink"}`}>
                {opt.label}
              </div>
              <div className="mt-0.5 text-xs text-ink-soft/70">{opt.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Issue tags ───────────────────────────────────────────────── */}
      <div>
        <label className="block text-sm font-semibold text-ink">
          Issue areas <span className="text-ink-soft/70 font-normal">(optional)</span>
        </label>
        <p className="mt-0.5 text-xs text-ink-soft/70">
          Helps others find and respond to this problem.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {ISSUE_TAG_OPTIONS.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
                selectedTags.includes(tag)
                  ? "border-amber/60 bg-amber/20 text-ink"
                  : "border-rule bg-card text-ink-soft hover:border-rule"
              }`}
            >
              {tag.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      </div>

      {/* ── Error ────────────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-lg border border-accent/25 bg-accent/10 px-4 py-3 text-sm text-accent">
          {error}
        </div>
      )}

      {/* ── What happens next ────────────────────────────────────────── */}
      <div className="rounded-lg border border-amber/60 bg-amber/20 px-4 py-3">
        <p className="text-xs text-ink">
          <span className="font-semibold">This posts publicly immediately.</span> The community can
          discuss the problem and help develop solutions. When you&apos;re ready to propose a
          specific action, you can turn it into a full initiative from the problem page.
        </p>
      </div>

      {/* ── Submit ───────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 border-t border-rule pt-6">
        <a href="/initiatives" className="text-sm text-ink-soft/70 hover:text-ink-soft">
          Cancel
        </a>
        <button
          type="submit"
          disabled={submitting || title.trim().length < 10}
          className="rounded-lg bg-amber px-6 py-2.5 text-sm font-semibold text-ink shadow-sm hover:bg-amber focus:outline-none focus:ring-2 focus:ring-amber/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "Posting…" : "Post problem"}
        </button>
      </div>
    </form>
  );
}
