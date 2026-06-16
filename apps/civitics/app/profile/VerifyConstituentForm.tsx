"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "inconclusive"; message: string }
  | { kind: "success"; jurisdictions: Array<{ id: string; name: string; type: string }> };

export function VerifyConstituentForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !address.trim()) return;
    setStatus({ kind: "submitting" });

    let res: Response;
    try {
      res = await fetch("/api/auth/verify-constituent", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), address: address.trim() }),
      });
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
      return;
    }

    if (res.status === 429) {
      setStatus({
        kind: "error",
        message: "Too many attempts in the last hour. Try again later.",
      });
      return;
    }
    if (res.status === 503) {
      setStatus({
        kind: "error",
        message: "Verification is temporarily unavailable. Please try again later.",
      });
      return;
    }
    if (!res.ok) {
      setStatus({ kind: "error", message: "Something went wrong. Please try again." });
      return;
    }

    const data = (await res.json()) as
      | { verified: true; jurisdictions: Array<{ id: string; name: string; type: string }> }
      | { verified: false; reason: string };

    if (!data.verified) {
      setStatus({
        kind: "inconclusive",
        message:
          "We couldn't match your address. Try a more specific street address, or contact support if the problem persists.",
      });
      return;
    }

    setStatus({ kind: "success", jurisdictions: data.jurisdictions });
    // Refresh the page so the SSR-rendered card replaces the form.
    router.refresh();
  }

  const submitting = status.kind === "submitting";

  return (
    <div className="mt-6 border border-rule bg-paper p-6">
      <h3 className="font-serif text-base font-semibold text-ink">Verify as a constituent</h3>
      <p className="mt-1 text-sm text-ink-soft">
        Confirm your name and home address to be recognized as a constituent in your
        jurisdictions. Your address is used once to determine your jurisdictions and is
        not stored.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <div>
          <label htmlFor="vc-name" className="block text-sm font-medium text-ink">
            Full name
          </label>
          <input
            id="vc-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
            disabled={submitting}
            className="mt-1 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div>
          <label htmlFor="vc-address" className="block text-sm font-medium text-ink">
            Home address
          </label>
          <input
            id="vc-address"
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            maxLength={300}
            placeholder="123 Main St, City, State ZIP"
            required
            disabled={submitting}
            className="mt-1 block w-full border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <button
          type="submit"
          disabled={submitting || !name.trim() || !address.trim()}
          className="inline-flex items-center border-[1.5px] border-ink bg-ink px-4 py-2 text-sm font-semibold text-paper transition-colors hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Verifying…" : "Verify"}
        </button>
      </form>

      {status.kind === "error" && (
        <p className="mt-3 text-sm text-red-600">{status.message}</p>
      )}
      {status.kind === "inconclusive" && (
        <p className="mt-3 text-sm text-amber-700">{status.message}</p>
      )}
      {status.kind === "success" && (
        <p className="mt-3 text-sm text-green-700">
          Verified as a constituent of{" "}
          {status.jurisdictions.map((j) => j.name).join(", ")}.
        </p>
      )}
    </div>
  );
}
