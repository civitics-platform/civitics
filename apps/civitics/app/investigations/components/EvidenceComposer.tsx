"use client";

// Investigations MVP PR2 (FIX-580) — the evidence-card composer. Enforces the
// citation-discipline rule in the UI: you CANNOT submit without ≥1 citation
// (mirrors the atomic add_evidence_card RPC). Edge cards require two endpoints +
// a relationship_kind from the assertable subset; context cards are claim + cite.
// The first citation rides POST /api/investigations/[id]/evidence (atomic with the
// card); any extras post to POST /api/evidence/[id]/citations. Tiers 1–2 only.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@civitics/db";
import type { User } from "@supabase/supabase-js";
import { challengedFetch } from "@/lib/challenged-fetch";
import {
  RELATIONSHIP_KINDS,
  INTERNAL_RECORD_KINDS,
  EDGE_ENDPOINT_KINDS,
  TIER2_DISCLAIMER,
  type PickedEntity,
} from "../_lib/presentation";
import { EntitySearchPicker } from "./EntitySearchPicker";

function redirectToSignIn(next: string) {
  window.location.href = `/auth/sign-in?next=${encodeURIComponent(next)}`;
}

type CitationDraft = {
  citation_type: "internal_record" | "imported_entity";
  target_type: string;
  target_id: string;
  name: string;
  kindLabel: string;
  excerpt: string;
};

export function EvidenceComposer({
  investigationId,
  signInNext,
}: {
  investigationId: string;
  signInNext: string;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);

  const [claimType, setClaimType] = useState<"edge" | "context">("context");
  const [claimText, setClaimText] = useState("");
  const [fromPick, setFromPick] = useState<PickedEntity | null>(null);
  const [toPick, setToPick] = useState<PickedEntity | null>(null);
  const [relationshipKind, setRelationshipKind] = useState("");
  const [privatePerson, setPrivatePerson] = useState(false);

  const [citations, setCitations] = useState<CitationDraft[]>([]);
  const [draftCiteType, setDraftCiteType] = useState<"internal_record" | "imported_entity">("internal_record");
  const [draftPick, setDraftPick] = useState<PickedEntity | null>(null);
  const [draftExcerpt, setDraftExcerpt] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMounted(true);
    const supabase = createBrowserClient();
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, session) => setUser(session?.user ?? null));
    return () => subscription.unsubscribe();
  }, []);

  function resetForm() {
    setClaimType("context");
    setClaimText("");
    setFromPick(null);
    setToPick(null);
    setRelationshipKind("");
    setPrivatePerson(false);
    setCitations([]);
    setDraftPick(null);
    setDraftExcerpt("");
    setDraftCiteType("internal_record");
    setError(null);
  }

  function addCitation() {
    if (!draftPick) return;
    setCitations((cur) => [
      ...cur,
      {
        citation_type: draftCiteType,
        target_type: draftPick.target_type,
        target_id: draftPick.target_id,
        name: draftPick.name,
        kindLabel: draftPick.kindLabel,
        excerpt: draftExcerpt.trim(),
      },
    ]);
    setDraftPick(null);
    setDraftExcerpt("");
  }

  function removeCitation(idx: number) {
    setCitations((cur) => cur.filter((_, i) => i !== idx));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (claimText.trim().length < 10) {
      setError("The claim must be at least 10 characters.");
      return;
    }
    if (claimType === "edge" && (!fromPick || !toPick || !relationshipKind)) {
      setError("An edge claim needs a from-entity, a to-entity, and a relationship.");
      return;
    }
    if (citations.length === 0) {
      setError("Add at least one citation — no claim without a cited record.");
      return;
    }

    const first = citations[0];
    if (!first) {
      setError("Add at least one citation — no claim without a cited record.");
      return;
    }

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        claim_text: claimText.trim(),
        claim_type: claimType,
        subject_is_private_person: privatePerson,
        citation_type: first.citation_type,
        citation_target_type: first.target_type,
        citation_target_id: first.target_id,
        citation_excerpt: first.excerpt || undefined,
      };
      if (claimType === "edge" && fromPick && toPick) {
        body.from_type = fromPick.target_type;
        body.from_id = fromPick.target_id;
        body.to_type = toPick.target_type;
        body.to_id = toPick.target_id;
        body.relationship_kind = relationshipKind;
      }

      const res = await challengedFetch(`/api/investigations/${investigationId}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        redirectToSignIn(signInNext);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok) {
        setError(
          res.status === 429
            ? data.error ?? "Daily evidence limit reached."
            : data.error ?? "Couldn't add the evidence card.",
        );
        return;
      }

      const cardId = data.id;
      // Post any additional citations (best-effort — the card already exists with
      // its first, atomic citation; the no-claim-without-citation rule is satisfied).
      let extraFailed = false;
      if (cardId && citations.length > 1) {
        for (const c of citations.slice(1)) {
          const r = await challengedFetch(`/api/evidence/${cardId}/citations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              citation_type: c.citation_type,
              target_type: c.target_type,
              target_id: c.target_id,
              excerpt: c.excerpt || undefined,
            }),
          });
          if (!r.ok) extraFailed = true;
        }
      }

      resetForm();
      setOpen(false);
      router.refresh();
      if (extraFailed) {
        // Surface non-fatally; the card + first citation landed.
        setOpen(true);
        setError("Card added, but one or more extra citations didn't save. You can re-add them.");
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!mounted) {
    return <div className="h-10 w-44 animate-pulse rounded bg-ink/5" />;
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => redirectToSignIn(signInNext)}
        className="rounded-md border border-rule px-3.5 py-2 text-sm font-medium text-ink hover:bg-ink/5"
      >
        Sign in to add evidence
      </button>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-paper hover:bg-ink/90"
      >
        Add cited evidence
      </button>
    );
  }

  const canSubmit = claimText.trim().length >= 10 && citations.length > 0 && !saving;

  return (
    <form onSubmit={submit} className="rounded-lg border border-rule bg-card/70 p-4">
      <h3 className="font-serif text-base text-ink">Add an evidence card</h3>
      <p className="mt-1 text-xs text-ink-soft">
        Every card must cite at least one record. Tiers 1–2 only (internal records and imported
        entities).
      </p>

      {/* Claim type */}
      <fieldset className="mt-4">
        <legend className="text-xs font-semibold uppercase tracking-wider text-ink-soft">Card type</legend>
        <div className="mt-1.5 flex gap-2">
          {(["context", "edge"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setClaimType(t)}
              aria-pressed={claimType === t}
              className={`rounded border px-3 py-1.5 text-sm ${
                claimType === t ? "border-ink bg-ink text-paper" : "border-rule text-ink hover:bg-ink/5"
              }`}
            >
              {t === "context" ? "Context" : "Relationship (edge)"}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-soft">
          {claimType === "edge"
            ? "Asserts a relationship between two entities — promotable to the graph once reviewed (later)."
            : "Enriches the case file. Never promoted to the graph."}
        </p>
      </fieldset>

      {/* Edge endpoints */}
      {claimType === "edge" && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-ink">From</label>
            {fromPick ? (
              <div className="mt-1 flex items-center justify-between gap-2 rounded border border-rule bg-paper px-2 py-1.5 text-sm">
                <span className="truncate text-ink">{fromPick.name}</span>
                <button type="button" onClick={() => setFromPick(null)} className="text-xs text-ink-soft hover:text-accent">
                  change
                </button>
              </div>
            ) : (
              <div className="mt-1">
                <EntitySearchPicker
                  kinds={EDGE_ENDPOINT_KINDS}
                  placeholder="Search official / agency / body / donor…"
                  onPick={setFromPick}
                />
              </div>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-ink">To</label>
            {toPick ? (
              <div className="mt-1 flex items-center justify-between gap-2 rounded border border-rule bg-paper px-2 py-1.5 text-sm">
                <span className="truncate text-ink">{toPick.name}</span>
                <button type="button" onClick={() => setToPick(null)} className="text-xs text-ink-soft hover:text-accent">
                  change
                </button>
              </div>
            ) : (
              <div className="mt-1">
                <EntitySearchPicker
                  kinds={EDGE_ENDPOINT_KINDS}
                  placeholder="Search official / agency / body / donor…"
                  onPick={setToPick}
                />
              </div>
            )}
          </div>
          <div className="sm:col-span-2">
            <label className="text-xs font-medium text-ink" htmlFor="rel-kind">
              Relationship
            </label>
            <select
              id="rel-kind"
              value={relationshipKind}
              onChange={(e) => setRelationshipKind(e.target.value)}
              className="mt-1 w-full rounded border border-rule bg-card px-3 py-2 text-sm text-ink focus:border-civic-blue focus:outline-none"
            >
              <option value="">Select a relationship…</option>
              {RELATIONSHIP_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Claim text */}
      <div className="mt-4">
        <label className="text-xs font-medium text-ink" htmlFor="claim-text">
          Claim <span className="text-accent">*</span>
        </label>
        <textarea
          id="claim-text"
          value={claimText}
          onChange={(e) => setClaimText(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="State the claim plainly. The citation must back it up."
          className="mt-1 w-full rounded border border-rule bg-card px-3 py-2 text-sm text-ink focus:border-civic-blue focus:outline-none"
        />
      </div>

      {/* Private-person */}
      <div className="mt-3">
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={privatePerson}
            onChange={(e) => setPrivatePerson(e.target.checked)}
            className="mt-0.5"
          />
          <span>This card concerns a private individual.</span>
        </label>
        {privatePerson && (
          <p className="mt-1 rounded border border-amber/60 bg-amber/15 px-3 py-2 text-[11px] leading-snug text-ink">
            Held for review: this card won&apos;t be public until an admin clears it. It needs
            corroboration before it appears to others.
          </p>
        )}
      </div>

      {/* Citations — mandatory */}
      <div className="mt-5 rounded-md border border-rule bg-paper p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Citations <span className="text-accent">*</span>
        </p>

        {citations.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1.5">
            {citations.map((c, i) => (
              <li
                key={`${c.target_type}:${c.target_id}:${i}`}
                className="flex items-center justify-between gap-2 rounded border border-rule bg-card px-2 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate text-ink">
                  <span className="text-[11px] text-ink-soft">
                    {c.citation_type === "imported_entity" ? "Tier 2" : "Tier 1"} · {c.kindLabel} ·{" "}
                  </span>
                  {c.name}
                  {c.excerpt && <span className="text-ink-soft"> — “{c.excerpt}”</span>}
                </span>
                <button
                  type="button"
                  onClick={() => removeCitation(i)}
                  className="shrink-0 text-xs text-ink-soft hover:text-accent"
                  aria-label={`Remove citation ${c.name}`}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Citation draft builder */}
        <div className="mt-3 border-t border-rule pt-3">
          <div className="flex gap-2">
            {(["internal_record", "imported_entity"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setDraftCiteType(t);
                  setDraftPick(null);
                }}
                aria-pressed={draftCiteType === t}
                className={`rounded border px-2.5 py-1 text-xs ${
                  draftCiteType === t ? "border-ink bg-ink text-paper" : "border-rule text-ink hover:bg-ink/5"
                }`}
              >
                {t === "internal_record" ? "Internal record (tier 1)" : "Imported entity (tier 2)"}
              </button>
            ))}
          </div>

          {draftCiteType === "imported_entity" && (
            <p className="mt-2 text-[11px] leading-snug text-ink-soft">{TIER2_DISCLAIMER}</p>
          )}

          <div className="mt-2">
            {draftPick ? (
              <div className="flex items-center justify-between gap-2 rounded border border-rule bg-card px-2 py-1.5 text-sm">
                <span className="truncate text-ink">
                  {draftPick.name} <span className="text-[11px] text-ink-soft">· {draftPick.kindLabel}</span>
                </span>
                <button type="button" onClick={() => setDraftPick(null)} className="text-xs text-ink-soft hover:text-accent">
                  change
                </button>
              </div>
            ) : (
              <EntitySearchPicker
                key={draftCiteType}
                kinds={draftCiteType === "internal_record" ? INTERNAL_RECORD_KINDS : undefined}
                imported={draftCiteType === "imported_entity"}
                placeholder={
                  draftCiteType === "internal_record"
                    ? "Search a record to cite…"
                    : "Search an imported entity (LittleSis / ICIJ)…"
                }
                onPick={setDraftPick}
              />
            )}
          </div>

          <input
            value={draftExcerpt}
            onChange={(e) => setDraftExcerpt(e.target.value)}
            placeholder="Optional excerpt / quote"
            maxLength={500}
            className="mt-2 w-full rounded border border-rule bg-card px-3 py-1.5 text-sm text-ink focus:border-civic-blue focus:outline-none"
          />

          <button
            type="button"
            onClick={addCitation}
            disabled={!draftPick}
            className="mt-2 rounded border border-rule px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
          >
            Add citation
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-accent">{error}</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            resetForm();
            setOpen(false);
          }}
          className="rounded-md px-3 py-2 text-sm text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
          title={citations.length === 0 ? "Add at least one citation first" : undefined}
        >
          {saving ? "Posting…" : "Post evidence"}
        </button>
      </div>
    </form>
  );
}
