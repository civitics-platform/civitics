"use client";

/**
 * FIX-763 — the surface-agnostic saved-views rail. One user_custom_groups row
 * = one saved view; the same component renders in the /search ScopeRail
 * (replacing the W1 disabled stub) and in the graph sidebar mount.
 *
 * Rows parse through parseSavedViewFilter: v2 payloads are BrowseState-native,
 * v1 GroupFilter rows up-compile on load (read-compat only — no row is ever
 * rewritten); unparseable rows render disabled with the parse error as title
 * (fail loudly, never silently-wrong). In graph mode each view also gets a [+]
 * that adds it as a live group — gated by the BrowseState→GroupFilter compiler,
 * disabled with the compiler's reason when the view can't form one.
 *
 * Anon behavior mirrors the pre-W2 custom-group fallback: saves that can't
 * persist (401 / network) are kept as session-only rows so the user never
 * loses the view mid-session.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowseState } from "@/lib/browse/types";
import {
  buildSavedViewPayload,
  parseSavedViewFilter,
  suggestedViewName,
  tryCompileBrowseToGroupFilter,
} from "@/lib/browse/graph-compiler";

/**
 * FIX-770 — shared saved-views refresh bus. Every mounted SavedViewsRail
 * subscribes; any persisted save (saveViewToServer) or delete notifies, so a
 * save on /search or the /graph sidebar mount is immediately visible on BOTH
 * surfaces (the W2 both-surface contract). Before this, each rail owned an
 * independent fetch with no cross-surface invalidation — a view saved from
 * /graph showed in /search but not back on /graph.
 */
const savedViewsListeners = new Set<() => void>();
function subscribeSavedViews(cb: () => void): () => void {
  savedViewsListeners.add(cb);
  return () => {
    savedViewsListeners.delete(cb);
  };
}
function notifySavedViewsChanged() {
  for (const cb of [...savedViewsListeners]) cb();
}

export interface SavedViewItem {
  /** user_custom_groups uuid, or `session-<n>` for unpersisted fallback rows. */
  id: string;
  name: string;
  state: BrowseState | null;
  /** 1 = legacy GroupFilter row (up-compiled), 2 = native payload. */
  version: 1 | 2 | null;
  isOwner: boolean;
  sessionOnly: boolean;
  /** Parse failure — row renders disabled with this as the reason. */
  error: string | null;
}

interface ServerRow {
  id: string;
  name: string;
  filter: unknown;
  is_owner?: boolean;
}

function toItem(row: ServerRow): SavedViewItem {
  try {
    const parsed = parseSavedViewFilter(row.filter);
    return {
      id: row.id, name: row.name, state: parsed.state, version: parsed.version,
      isOwner: row.is_owner === true, sessionOnly: false, error: null,
    };
  } catch (e) {
    return {
      id: row.id, name: row.name, state: null, version: null,
      isOwner: row.is_owner === true, sessionOnly: false,
      error: e instanceof Error ? e.message : "unreadable saved view",
    };
  }
}

/**
 * Persist a view (v2 payload). Best-effort: 401/network failures resolve
 * persisted:false so callers fall back to session-only, mirroring the pre-W2
 * custom-group anon behavior.
 */
export async function saveViewToServer(
  name: string,
  state: BrowseState,
): Promise<{ persisted: boolean; row: ServerRow | null }> {
  try {
    const res = await fetch("/api/graph/custom-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filter: buildSavedViewPayload(state) }),
      credentials: "include",
    });
    if (!res.ok) return { persisted: false, row: null };
    const data = (await res.json()) as { group?: ServerRow };
    // Fan out to every mounted rail (both surfaces) so the new view appears
    // everywhere without a page reload (FIX-770).
    notifySavedViewsChanged();
    return { persisted: true, row: data.group ?? null };
  } catch {
    return { persisted: false, row: null };
  }
}

let sessionSeq = 0;

export function SavedViewsRail({
  currentState,
  onApply,
  onAddGroup,
  activeGroupIds = [],
  refreshNonce = 0,
  showSaveRow = true,
}: {
  currentState: BrowseState;
  onApply: (state: BrowseState, name: string) => void;
  /** Graph mount: add this view as a live group. Called only when compilable. */
  onAddGroup?: (item: SavedViewItem) => void;
  /** Graph mount: focus group ids, so an added view renders as ✓. */
  activeGroupIds?: string[];
  /** Bump to re-fetch after an external save (sidebar add-all / save-view). */
  refreshNonce?: number;
  /** /search rail renders the inline "+ save current view" row; graph mount has its own button. */
  showSaveRow?: boolean;
}) {
  const [items, setItems] = useState<SavedViewItem[] | null>(null);
  const [sessionItems, setSessionItems] = useState<SavedViewItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [savingOpen, setSavingOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const reloadSeq = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Single read path shared by mount, the external refreshNonce, and the
  // module bus. cache:"no-store" defeats the browser HTTP cache so an
  // in-session re-fetch after a save never serves a stale list (FIX-770). A
  // sequence guard keeps the latest reload authoritative when several fire in
  // quick succession (save → notify → reload racing an in-flight one).
  const reload = useCallback(() => {
    const seq = ++reloadSeq.current;
    fetch("/api/graph/custom-groups", { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { groups?: ServerRow[] }) => {
        if (mountedRef.current && seq === reloadSeq.current) setItems((data.groups ?? []).map(toItem));
      })
      .catch(() => {
        if (mountedRef.current && seq === reloadSeq.current) setItems([]);
      });
  }, []);

  useEffect(() => {
    reload();
    return subscribeSavedViews(reload);
  }, [refreshNonce, reload]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    const name = (saveName.trim() || suggestedViewName(currentState)).slice(0, 80);
    setSaving(true);
    setNotice(null);
    const { persisted, row } = await saveViewToServer(name, currentState);
    setSaving(false);
    setSavingOpen(false);
    setSaveName("");
    if (persisted && row) {
      setItems((prev) => [toItem({ ...row, is_owner: true }), ...(prev ?? [])]);
    } else {
      // Session-only fallback (anon / network) — mirrors pre-W2 custom groups.
      setSessionItems((prev) => [{
        id: `session-${++sessionSeq}`, name, state: { ...currentState, cursor: null },
        version: 2, isOwner: true, sessionOnly: true, error: null,
      }, ...prev]);
      setNotice("Not signed in — view kept for this session only");
    }
  }, [saving, saveName, currentState]);

  const handleDelete = useCallback(async (item: SavedViewItem) => {
    if (item.sessionOnly) {
      setSessionItems((prev) => prev.filter((i) => i.id !== item.id));
      return;
    }
    try {
      const res = await fetch(`/api/graph/custom-groups?id=${encodeURIComponent(item.id)}`, {
        method: "DELETE", credentials: "include",
      });
      if (res.ok) {
        setItems((prev) => (prev ?? []).filter((i) => i.id !== item.id));
        // Drop it on every other mounted rail too (FIX-770).
        notifySavedViewsChanged();
      }
    } catch { /* leave the row; next refresh reconciles */ }
  }, []);

  const all = [...sessionItems, ...(items ?? [])];

  return (
    <div>
      {showSaveRow && (
        savingOpen ? (
          <div className="px-2 py-1">
            <input
              type="text"
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
                if (e.key === "Escape") { setSavingOpen(false); setSaveName(""); }
              }}
              placeholder={suggestedViewName(currentState)}
              maxLength={80}
              className="w-full rounded-[2px] border border-term-line bg-paper px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-soft/60 focus:border-accent focus:outline-none"
            />
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="font-mono text-[10.5px] text-green-ink hover:text-green-ink/80 disabled:opacity-50 focus-visible:outline-none focus-visible:text-accent"
              >
                {saving ? "saving…" : "save"}
              </button>
              <button
                onClick={() => { setSavingOpen(false); setSaveName(""); }}
                className="font-mono text-[10.5px] text-ink-soft/60 hover:text-ink focus-visible:outline-none focus-visible:text-accent"
              >
                cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setSavingOpen(true)}
            className="w-full px-2 py-1 text-left font-mono text-[11px] text-ink-soft transition-colors hover:text-amber focus-visible:outline-none focus-visible:text-accent"
          >
            + save current view
          </button>
        )
      )}

      {notice && (
        <p className="px-2 py-1 font-mono text-[10px] text-amber">{notice}</p>
      )}

      {items === null && (
        <p className="px-2 py-1 font-mono text-[10.5px] text-ink-soft/50">loading views…</p>
      )}

      {items !== null && all.length === 0 && (
        <p className="px-2 py-1 font-mono text-[10.5px] text-ink-soft/50">
          no saved views yet
        </p>
      )}

      {all.map((item) => {
        const compilable = onAddGroup && item.state ? tryCompileBrowseToGroupFilter(item.state) : null;
        const isActive = activeGroupIds.includes(`group-view-${item.id}`);
        return (
          <div
            key={item.id}
            className="group/view flex items-center gap-1.5 px-2 py-[3px]"
          >
            <button
              onClick={() => { if (item.state) onApply(item.state, item.name); }}
              disabled={!item.state}
              title={item.error ?? (item.version === 1 ? `${item.name} (legacy group — upgraded on load)` : item.name)}
              className={`min-w-0 flex-1 truncate text-left font-mono text-[11.5px] transition-colors focus-visible:outline-none focus-visible:text-accent
                ${item.state ? "text-viz-3 hover:text-amber" : "cursor-not-allowed text-ink-soft/40 line-through"}`}
            >
              ★ {item.name}
              {item.sessionOnly && <span className="ml-1 text-[9px] text-ink-soft/50">(session)</span>}
            </button>
            {onAddGroup && item.state && (
              <button
                onClick={() => { if (compilable?.ok && !isActive) onAddGroup(item); }}
                disabled={!compilable?.ok || isActive}
                title={
                  isActive ? "Already on the graph"
                    : compilable?.ok ? `Add ${item.name} to the graph as a live group`
                    : compilable?.reason ?? "Not groupable"
                }
                className={`shrink-0 rounded-[2px] border px-1 font-mono text-[10.5px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent
                  ${isActive
                    ? "cursor-default border-green-ink/40 text-green-ink"
                    : compilable?.ok
                      ? "border-green-ink/40 text-green-ink hover:bg-green-ink/15"
                      : "cursor-not-allowed border-term-line text-ink-soft/40"}`}
              >
                {isActive ? "✓" : "+"}
              </button>
            )}
            {(item.isOwner || item.sessionOnly) && (
              <button
                onClick={() => void handleDelete(item)}
                title="Delete saved view"
                className="shrink-0 font-mono text-[10.5px] text-ink-soft/0 transition-colors hover:!text-accent group-hover/view:text-ink-soft/60 focus-visible:outline-none focus-visible:text-accent"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
