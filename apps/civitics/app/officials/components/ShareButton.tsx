"use client";

import { useState } from "react";

export function ShareButton({ name, url }: { name: string; url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    const fullUrl = window.location.origin + url;

    if (navigator.share) {
      await navigator.share({
        title: `${name} — Civitics`,
        text: `Check out ${name}'s civic profile on Civitics`,
        url: fullUrl,
      });
    } else {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <button
      onClick={handleShare}
      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
    >
      {copied ? "✓ Copied" : "↗ Share"}
    </button>
  );
}
