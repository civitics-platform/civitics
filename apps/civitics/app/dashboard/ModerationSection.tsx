"use client";

import { useCallback, useEffect, useState } from "react";
import { useIsAdmin } from "@/lib/use-is-admin";

type Flag = {
  id: string;
  content_type: "civic_comment" | "official_community_comment";
  content_id: string;
  user_id: string;
  reason: string;
  note: string | null;
  resolved: boolean;
  created_at: string;
  content: {
    body: string;
    user_id: string;
    is_deleted: boolean;
    proposal_id?: string | null;
    official_id?: string | null;
  } | null;
};

// Promotion-review card (FIX-585).
type PromotionCard = {
  id: string;
  investigation_id: string;
  investigation_title: string;
  claim_text: string;
  from_type: string | null;
  to_type: string | null;
  from_name: string;
  to_name: string;
  relationship_kind: string | null;
  status: string;
  subject_is_private_person: boolean;
  citation_count: number;
  corroboration_count: number;
};

// Dispute flag on an investigation_evidence card (FIX-585).
type DisputeFlag = {
  id: string;
  content_id: string;
  reason: string;
  note: string | null;
  created_at: string;
  card: {
    id: string;
    investigation_id: string;
    investigation_title: string;
    claim_text: string;
    status: string;
    relationship_kind: string | null;
  } | null;
};

type Queue = "comments" | "promotion" | "disputes";

const REASON_LABELS: Record<string, string> = {
  spam:           "Spam",
  harassment:     "Harassment",
  off_topic:      "Off-topic",
  misinformation: "Misinformation",
  other:          "Other",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day:   "numeric",
    hour:  "numeric",
    minute:"2-digit",
  });
}

function contextLink(flag: Flag): string | null {
  if (!flag.content) return null;
  if (flag.content_type === "civic_comment" && flag.content.proposal_id) {
    return `/proposals/${flag.content.proposal_id}`;
  }
  if (flag.content_type === "official_community_comment" && flag.content.official_id) {
    return `/officials/${flag.content.official_id}`;
  }
  return null;
}

export function ModerationSection() {
  const { isAdmin, loading: adminLoading } = useIsAdmin();
  const [queue, setQueue] = useState<Queue>("comments");
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [promotion, setPromotion] = useState<PromotionCard[] | null>(null);
  const [disputes, setDisputes] = useState<DisputeFlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"pending" | "resolved">("pending");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setError(null);
    try {
      if (queue === "comments") {
        const res = await fetch(`/api/admin/moderation?queue=comments&resolved=${tab === "resolved" ? 1 : 0}`);
        if (res.status === 403) { setFlags([]); setError("admin"); return; }
        if (!res.ok) throw new Error("Failed to load flags");
        setFlags((await res.json()).flags ?? []);
      } else if (queue === "promotion") {
        const res = await fetch(`/api/admin/moderation?queue=promotion`);
        if (res.status === 403) { setPromotion([]); setError("admin"); return; }
        if (!res.ok) throw new Error("Failed to load promotion queue");
        setPromotion((await res.json()).cards ?? []);
      } else {
        const res = await fetch(`/api/admin/moderation?queue=disputes&resolved=${tab === "resolved" ? 1 : 0}`);
        if (res.status === 403) { setDisputes([]); setError("admin"); return; }
        if (!res.ok) throw new Error("Failed to load disputes");
        setDisputes((await res.json()).flags ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [queue, tab, isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  if (adminLoading) return null;
  if (!isAdmin) return null;
  if (error === "admin") return null;

  // Comment-flag actions (unchanged).
  const act = async (flagId: string, action: "dismiss" | "delete") => {
    setBusy(flagId);
    try {
      const res = await fetch("/api/admin/moderation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag_id: flagId, action }),
      });
      if (res.ok) setFlags((prev) => (prev ? prev.filter((f) => f.id !== flagId) : prev));
    } finally {
      setBusy(null);
    }
  };

  // Investigation actions (card_id-keyed).
  const cardAct = async (cardId: string, action: "promote" | "reject" | "clear" | "unpromote" | "dismiss_flags") => {
    setBusy(cardId);
    try {
      const res = await fetch("/api/admin/moderation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_id: cardId, action }),
      });
      if (res.ok) {
        setPromotion((prev) => (prev ? prev.filter((c) => c.id !== cardId) : prev));
        setDisputes((prev) => (prev ? prev.filter((d) => d.content_id !== cardId) : prev));
      }
    } finally {
      setBusy(null);
    }
  };

  const QueueBtn = ({ id, label }: { id: Queue; label: string }) => (
    <button
      type="button"
      onClick={() => setQueue(id)}
      className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
        queue === id ? "bg-indigo-600 text-white" : "text-gray-600 hover:text-gray-900"
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Content Moderation</h2>
          <p className="text-xs text-gray-400">User reports + investigation evidence review. Admin-only.</p>
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 p-1">
          <QueueBtn id="comments" label="Comments" />
          <QueueBtn id="promotion" label="Promotion" />
          <QueueBtn id="disputes" label="Disputes" />
        </div>
      </div>

      {/* pending/resolved sub-toggle applies to comments + disputes */}
      {queue !== "promotion" && (
        <div className="mb-3 flex gap-1 rounded-lg border border-gray-200 p-1 w-fit">
          {(["pending", "resolved"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === t ? "bg-gray-800 text-white" : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {t === "pending" ? "Pending" : "Resolved"}
            </button>
          ))}
        </div>
      )}

      {/* ── Comments queue (unchanged behavior) ── */}
      {queue === "comments" &&
        (flags === null ? (
          <div className="text-xs text-gray-400">Loading…</div>
        ) : flags.length === 0 ? (
          <div className="text-xs text-gray-400 py-4 text-center">
            {tab === "pending" ? "No pending flags." : "No resolved flags yet."}
          </div>
        ) : (
          <ul className="space-y-3">
            {flags.map((f) => {
              const link = contextLink(f);
              const body = f.content?.body ?? "(content unavailable)";
              return (
                <li key={f.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                        {REASON_LABELS[f.reason] ?? f.reason}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {f.content_type === "civic_comment" ? "Proposal comment" : "Official comment"}
                      </span>
                      <span className="text-[10px] text-gray-400">{formatDate(f.created_at)}</span>
                      {f.content?.is_deleted && (
                        <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">already deleted</span>
                      )}
                    </div>
                    {link && (
                      <a href={link} target="_blank" rel="noopener noreferrer" className="text-[10px] text-indigo-600 hover:underline">
                        open context ↗
                      </a>
                    )}
                  </div>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{body}</p>
                  {f.note && <p className="mt-2 text-[11px] text-gray-500 italic">Reporter note: {f.note}</p>}
                  {!f.resolved && (
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => act(f.id, "dismiss")} disabled={busy === f.id}
                        className="rounded border border-gray-300 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                        Dismiss
                      </button>
                      <button type="button" onClick={() => act(f.id, "delete")} disabled={busy === f.id || f.content?.is_deleted}
                        className="rounded bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50">
                        {busy === f.id ? "…" : "Delete comment"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ))}

      {/* ── Promotion-review queue ── */}
      {queue === "promotion" &&
        (promotion === null ? (
          <div className="text-xs text-gray-400">Loading…</div>
        ) : promotion.length === 0 ? (
          <div className="text-xs text-gray-400 py-4 text-center">No cards awaiting promotion review.</div>
        ) : (
          <ul className="space-y-3">
            {promotion.map((c) => (
              <li key={c.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                    {c.status === "promoted" ? "Promoted · disputed" : "Corroborated"}
                  </span>
                  <span className="text-[10px] text-gray-500">{c.corroboration_count} independent · {c.citation_count} citations</span>
                  {c.subject_is_private_person && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">private individual</span>
                  )}
                  <a href={`/investigations/${c.investigation_id}`} target="_blank" rel="noopener noreferrer"
                    className="ml-auto text-[10px] text-indigo-600 hover:underline">
                    {c.investigation_title || "case file"} ↗
                  </a>
                </div>
                <p className="text-[11px] font-medium text-gray-500">
                  {c.from_name || c.from_type} <span className="text-gray-400">—{(c.relationship_kind ?? "").replace(/_/g, " ")}→</span> {c.to_name || c.to_type}
                </p>
                <p className="mt-1 text-sm text-gray-800 leading-relaxed">{c.claim_text}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {c.status === "corroborated" && (
                    <button type="button" onClick={() => cardAct(c.id, "promote")} disabled={busy === c.id}
                      className="rounded bg-green-700 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-green-800 disabled:opacity-50">
                      {busy === c.id ? "…" : "Approve → promote"}
                    </button>
                  )}
                  {c.status === "promoted" && (
                    <button type="button" onClick={() => cardAct(c.id, "unpromote")} disabled={busy === c.id}
                      className="rounded border border-gray-300 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      Unpromote
                    </button>
                  )}
                  <button type="button" onClick={() => cardAct(c.id, "reject")} disabled={busy === c.id}
                    className="rounded bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50">
                    Reject
                  </button>
                  {c.subject_is_private_person && (
                    <button type="button" onClick={() => cardAct(c.id, "clear")} disabled={busy === c.id}
                      className="rounded border border-amber-400 bg-white px-2.5 py-1 text-[11px] text-amber-800 hover:bg-amber-50 disabled:opacity-50">
                      Clear private-person
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ))}

      {/* ── Disputes queue ── */}
      {queue === "disputes" &&
        (disputes === null ? (
          <div className="text-xs text-gray-400">Loading…</div>
        ) : disputes.length === 0 ? (
          <div className="text-xs text-gray-400 py-4 text-center">
            {tab === "pending" ? "No open disputes." : "No resolved disputes yet."}
          </div>
        ) : (
          <ul className="space-y-3">
            {disputes.map((d) => (
              <li key={d.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                    {REASON_LABELS[d.reason] ?? d.reason}
                  </span>
                  {d.card && (
                    <span className="text-[10px] text-gray-500">card status: {d.card.status}</span>
                  )}
                  <span className="text-[10px] text-gray-400">{formatDate(d.created_at)}</span>
                  {d.card && (
                    <a href={`/investigations/${d.card.investigation_id}`} target="_blank" rel="noopener noreferrer"
                      className="ml-auto text-[10px] text-indigo-600 hover:underline">
                      {d.card.investigation_title || "case file"} ↗
                    </a>
                  )}
                </div>
                <p className="text-sm text-gray-800 leading-relaxed">{d.card?.claim_text ?? "(card unavailable)"}</p>
                {d.note && <p className="mt-2 text-[11px] text-gray-500 italic">Reporter note: {d.note}</p>}
                {d.card && d.card.status !== "rejected" && (
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => cardAct(d.content_id, "dismiss_flags")} disabled={busy === d.content_id}
                      className="rounded border border-gray-300 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      Dismiss flags
                    </button>
                    <button type="button" onClick={() => cardAct(d.content_id, "reject")} disabled={busy === d.content_id}
                      className="rounded bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50">
                      {busy === d.content_id ? "…" : "Reject card"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
