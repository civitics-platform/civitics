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
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          onClick={() => act("reject")}
          disabled={busy !== null}
          className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
        >
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {error && <p className="text-[10px] text-red-600">{error}</p>}
    </div>
  );
}
