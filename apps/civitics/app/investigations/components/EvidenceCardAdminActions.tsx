"use client";

// Investigations MVP PR3 (FIX-585) — admin-only promote affordance on an evidence
// card, rendered next to the status badge in the case-file page. Non-admins render
// nothing (the server already shows the status badge). The actions POST to the
// existing ADMIN_EMAIL-gated /api/admin/moderation endpoint (same gate + the same
// promote/unpromote/reject/clear RPCs the dashboard review queue uses).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/use-is-admin";

type Action = "promote" | "unpromote" | "reject" | "clear";

export function EvidenceCardAdminActions({
  cardId,
  status,
  subjectIsPrivatePerson,
}: {
  cardId: string;
  status: "proposed" | "corroborated" | "disputed" | "promoted" | "rejected";
  subjectIsPrivatePerson: boolean;
}) {
  const { isAdmin, loading } = useIsAdmin();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (loading || !isAdmin) return null;

  const run = async (action: Action) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/moderation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_id: cardId, action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setErr(body?.error ?? "Action failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const btn = "rounded border px-1.5 py-0.5 text-[11px] font-medium disabled:opacity-50";

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {status === "corroborated" && (
        <button type="button" onClick={() => run("promote")} disabled={busy}
          className={`${btn} border-green-ink/30 bg-green-ink/10 text-green-ink hover:bg-green-ink/20`}>
          {busy ? "…" : "Promote to graph"}
        </button>
      )}
      {status === "promoted" && (
        <button type="button" onClick={() => run("unpromote")} disabled={busy}
          className={`${btn} border-rule bg-card text-ink-soft hover:bg-ink/5`}>
          Unpromote
        </button>
      )}
      {(status === "corroborated" || status === "disputed" || status === "promoted") && (
        <button type="button" onClick={() => run("reject")} disabled={busy}
          className={`${btn} border-accent/30 bg-accent/10 text-accent hover:bg-accent/20`}>
          Reject
        </button>
      )}
      {subjectIsPrivatePerson && (
        <button type="button" onClick={() => run("clear")} disabled={busy}
          className={`${btn} border-amber/60 bg-amber/20 text-ink hover:bg-amber/30`}>
          Clear private-person
        </button>
      )}
      {err && <span className="text-[11px] text-accent">{err}</span>}
    </span>
  );
}
