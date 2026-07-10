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
 * FIX-770 / FIX-784 — shared saved-views bus. Every mounted SavedViewsRail
 * subscribes, so a save/delete on /search or the /graph sidebar mount is
 * immediately visible on BOTH surfaces (the W2 both-surface contract).
 *
 * FIX-784 — the bus carries the changed ROW (upsert) or id (remove), NOT a
 * bare "refetch" signal. The original design (FIX-770) had every listener
 * re-GET the whole list on notify; on prod that post-write GET fires while the
 * POST's middleware is rotating the auth cookie, so it can race a rotated-out
 * token and come back authenticated-as-anon → an empty 200 → the list wiped
 * the just-saved row on every surface (the reported regression). Broadcasting
 * the delta from the already-confirmed POST/DELETE response removes that
 * post-write GET entirely, so listing a save no longer depends on a second
 * authenticated round-trip. The mount fetch (a standalone GET, not chained
 * after a write) still loads the existing list.
 */
type SavedViewEvent =
  | { type: "upsert"; row: ServerRow }
  | { type: "remove"; id: string };

const savedViewsListeners = new Set<(e: SavedViewEvent) => void>();
function subscribeSavedViews(cb: (e: SavedViewEvent) => void): () => void {
  savedViewsListeners.add(cb);
  return () => {
    savedViewsListeners.delete(cb);
  };
}
function notifySavedView(e: SavedViewEvent) {
  for (const cb of [...savedViewsListeners]) cb(e);
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
    // Broadcast the confirmed row so every mounted rail (both surfaces) lists it
    // without a second GET — the POST response IS authoritative (FIX-784).
    if (data.group) notifySavedView({ type: "upsert", row: data.group });
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
  // FIX-782 — set when the most recent reload GET failed and we chose to keep
  // the rows we already have rather than wipe them. Surfaces a quiet stale hint.
  const [stale, setStale] = useState(false);

  const mountedRef = useRef(true);
  const reloadSeq = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Mount + external-refreshNonce read path. This is a STANDALONE GET (not
  // chained after a write), so it authenticates reliably — unlike the post-write
  // refetch the module bus used to trigger, which raced the auth-cookie rotation
  // on prod (FIX-784). In-session save/delete deltas arrive via the bus and
  // applyEvent below; this fetch only loads the existing list.
  //
  // NB: `items` holds only server-persisted rows; anon/session-only fallback
  // rows live in the separate `sessionItems` state that reload never touches,
  // so they survive every refetch (FIX-782). A sequence guard keeps the latest
  // reload authoritative when several fire in quick succession.
  const reload = useCallback(() => {
    const seq = ++reloadSeq.current;
    fetch("/api/graph/custom-groups", { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { groups?: ServerRow[] }) => {
        if (mountedRef.current && seq === reloadSeq.current) {
          setItems((data.groups ?? []).map(toItem));
          setStale(false);
        }
      })
      .catch(() => {
        // FIX-782 — a failed/empty refetch must NEVER wipe rows we already have.
        // FIX-770's bus fans a reload to every mounted rail on each save/delete,
        // so the old `setItems([])` here turned one transient GET failure (prod:
        // the 8s authenticator role-read timeout under cache starvation) into a
        // wipe of the just-saved view on every surface. Keep prior rows; fall
        // back to [] only on the very first load (nothing to lose) and flag the
        // list stale so the UI can hint that it may be out of date.
        if (mountedRef.current && seq === reloadSeq.current) {
          setItems((prev) => prev ?? []);
          setStale(true);
        }
      });
  }, []);

  useEffect(() => {
    reload();
  }, [refreshNonce, reload]);

  // Apply a bus delta to local state — an upsert (save, dedup by id so the
  // saver's own optimistic insert and the broadcast can't double up) or a
  // remove (delete). No network: the row/id came from an already-confirmed
  // write, so listing it never depends on a second authenticated GET (FIX-784).
  const applyEvent = useCallback((e: SavedViewEvent) => {
    if (!mountedRef.current) return;
    setItems((prev) => {
      const list = prev ?? [];
      if (e.type === "remove") return list.filter((i) => i.id !== e.id);
      const item = toItem(e.row);
      return [item, ...list.filter((i) => i.id !== item.id)];
    });
    setStale(false);
  }, []);

  useEffect(() => subscribeSavedViews(applyEvent), [applyEvent]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    const name = (saveName.trim() || suggestedViewName(currentState)).slice(0, 80);
    setSaving(true);
    setNotice(null);
    const { persisted } = await saveViewToServer(name, currentState);
    setSaving(false);
    setSavingOpen(false);
    setSaveName("");
    if (!persisted) {
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
      // 404 = the row is already gone (a stale/phantom id), so the goal state —
      // absent — is achieved; drop it from the UI just like a 200 (FIX-784).
      if (res.ok || res.status === 404) {
        // Broadcast the removal so every mounted rail drops it — no refetch.
        notifySavedView({ type: "remove", id: item.id });
      }
    } catch { /* leave the row; next mount reconciles */ }
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

      {stale && (
        // FIX-782 — the last refetch failed; we kept the prior rows rather than
        // wipe them. Quiet hint so the list isn't silently presented as fresh.
        <p className="px-2 py-1 font-mono text-[10px] text-ink-soft/50">
          couldn’t refresh — showing last known views
        </p>
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
