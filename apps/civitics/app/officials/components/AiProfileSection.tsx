"use client";

/**
 * AiProfileSection
 *
 * Used on the official profile page when no cached summary is available
 * at render time. Fetches on mount and displays a 2-sentence civic profile.
 * Result is cached server-side — subsequent visitors see it instantly.
 */

import { useEffect, useState } from "react";

type Props = {
  officialId: string;
};

// Survives tab switches: ProfileTabs unmounts the overview subtree when
// another tab is active, so without this cache every return to Overview
// refires the fetch (and shows the "Generating…" spinner).
const summaryCache = new Map<string, string | null>();

export function AiProfileSection({ officialId }: Props) {
  const hasCached = summaryCache.has(officialId);
  const [summary, setSummary] = useState<string | null>(
    hasCached ? summaryCache.get(officialId) ?? null : null,
  );
  const [loading, setLoading] = useState(!hasCached);

  useEffect(() => {
    if (summaryCache.has(officialId)) {
      setSummary(summaryCache.get(officialId) ?? null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    // FIX-1029 — the STATUS is checked, not just the body. The route now
    // answers an infrastructure failure with 503 `{summary: null, error:
    // "unavailable"}` and a genuine no-record with 200 `{summary: null}`. Both
    // carry a null summary, so reading `data.summary` alone would file an
    // outage into `summaryCache` as "this official has no profile" — and that
    // Map is module-scoped and never expires, so one 503 during a deploy would
    // suppress the profile for the rest of the browser session. This is the
    // client-side twin of the FIX-796 rule that keeps a transient null off the
    // CDN: a failure is never cached, at any layer.
    // `answered` is what separates the two null summaries: a 200 null is an
    // answer worth caching (this official has no record — don't re-ask on every
    // tab switch), a 503 null is not.
    fetch(`/api/officials/${officialId}/summary`)
      .then(async (r): Promise<{ answered: boolean; summary: string | null }> => {
        if (!r.ok) return { answered: false, summary: null };
        const data = (await r.json()) as { summary: string | null };
        return { answered: true, summary: data.summary ?? null };
      })
      .then(({ answered, summary: s }) => {
        if (answered) summaryCache.set(officialId, s);
        if (!cancelled) {
          setSummary(s);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [officialId]);

  if (loading) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-ink-soft">
        <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-rule border-t-accent" />
        Generating civic profile…
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="mt-3 border border-civic-blue/20 bg-civic-blue/5 px-4 py-3">
      <p className="text-sm text-ink leading-relaxed">{summary}</p>
      <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-civic-blue/70">Civic profile · AI generated</p>
    </div>
  );
}
