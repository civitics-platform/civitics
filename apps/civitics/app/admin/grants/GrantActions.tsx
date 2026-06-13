"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// FIX-559: approve/reject buttons for a pending claim row. POSTs to
// /api/admin/grants/[id] then refreshes the server-rendered queue.
export function GrantActions({ grantId }: { grantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "reject") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/admin/grants/${grantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? `failed (${res.status})`);
        setBusy(null);
        return;
      }
      router.refresh();
    } catch {
      setError("network error");
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          onClick={() => act("approve")}
          disabled={busy !== null}
          className="bg-ink px-3 py-1.5 text-xs font-medium text-paper hover:bg-green-ink disabled:opacity-50 transition-colors"
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          onClick={() => act("reject")}
          disabled={busy !== null}
          className="border border-rule bg-card px-3 py-1.5 text-xs font-medium text-accent hover:border-accent hover:bg-accent/5 disabled:opacity-50 transition-colors"
        >
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {error && <p className="text-[10px] text-accent">{error}</p>}
    </div>
  );
}
