"use client";

/**
 * FIX-768 — the two lazy discovery-path trees rendered in the ScopeRail when a
 * non-Branch root is active (the switcher lives in ScopeRail).
 *
 *  - PlaceTree: the jurisdiction hierarchy, drilled one level at a time via
 *    /api/browse/jurisdictions (~10.5k nodes never load eagerly). Each node
 *    links to its jurisdiction page; expandable types drill in place.
 *  - TopicList: the proposal tag taxonomy from /api/graph/tag-groups (the same
 *    source the graph uses). Each topic deep-links into the proposals explorer
 *    via a text-query bridge — the index has no tag facet column, so precise
 *    per-tag faceting is a flagged follow-up, not this wave.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatCountCompact } from "./format";

// ── By Place ─────────────────────────────────────────────────────────────────

interface PlaceNode {
  id: string;
  name: string;
  short_name: string | null;
  type: string;
  expandable: boolean;
}

const ROOT_KEY = "__root__";

export function PlaceTree() {
  const [childrenBy, setChildrenBy] = useState<Record<string, PlaceNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState(false);
  // Keys already requested — dedupes re-expands and the StrictMode double mount.
  const requestedRef = useRef<Set<string>>(new Set());

  const fetchChildren = useCallback(async (key: string, parentId: string | null) => {
    if (requestedRef.current.has(key)) return;
    requestedRef.current.add(key);
    setLoadingKeys((s) => new Set(s).add(key));
    try {
      const url = parentId
        ? `/api/browse/jurisdictions?parent=${encodeURIComponent(parentId)}`
        : "/api/browse/jurisdictions";
      const res = await fetch(url);
      const data = res.ok ? await res.json() : { nodes: [] };
      setChildrenBy((c) => ({ ...c, [key]: (data.nodes ?? []) as PlaceNode[] }));
    } catch {
      setError(true);
      requestedRef.current.delete(key); // allow a retry on the next expand
    } finally {
      setLoadingKeys((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }, []);

  useEffect(() => {
    fetchChildren(ROOT_KEY, null);
  }, [fetchChildren]);

  const toggle = (node: PlaceNode) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else {
        next.add(node.id);
        fetchChildren(node.id, node.id);
      }
      return next;
    });
  };

  const renderLevel = (key: string, depth: number) => {
    const nodes = childrenBy[key];
    const pad = `${8 + depth * 14}px`;
    if (!nodes) {
      return loadingKeys.has(key) ? (
        <p className="py-1 font-mono text-[10.5px] text-ink-soft/50" style={{ paddingLeft: pad }}>loading…</p>
      ) : null;
    }
    if (nodes.length === 0) {
      return <p className="py-1 font-mono text-[10.5px] text-ink-soft/40" style={{ paddingLeft: pad }}>no sub-places</p>;
    }
    return nodes.map((node) => {
      const isOpen = expanded.has(node.id);
      const showState = node.type === "state" && node.short_name;
      return (
        <div key={node.id}>
          <div
            className="group flex items-center gap-1.5 rounded-[2px] py-1 pr-2 font-mono text-[12px] text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink"
            style={{ paddingLeft: pad }}
          >
            <button
              onClick={() => node.expandable && toggle(node)}
              className="w-[12px] shrink-0 text-left text-[9px] text-ink-soft/60 focus-visible:outline-none focus-visible:text-accent"
              aria-label={node.expandable ? (isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`) : node.name}
              tabIndex={node.expandable ? 0 : -1}
            >
              {node.expandable ? (isOpen ? "▾" : "▸") : ""}
            </button>
            <Link
              href={`/jurisdictions/${node.id}`}
              className="min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:text-accent hover:text-amber"
              title={`Open ${node.name}`}
            >
              {node.name}{showState ? ` (${node.short_name})` : ""}
            </Link>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-soft/40">{node.type}</span>
          </div>
          {node.expandable && isOpen && renderLevel(node.id, depth + 1)}
        </div>
      );
    });
  };

  if (error) {
    return <p className="px-2 py-2 font-mono text-[11px] text-accent">Couldn&apos;t load places.</p>;
  }
  return <nav aria-label="Browse by place">{renderLevel(ROOT_KEY, 0)}</nav>;
}

// ── By Topic ─────────────────────────────────────────────────────────────────

interface TopicRow {
  tag: string;
  label: string;
  icon: string | null;
  count: number;
}

export function TopicList() {
  const [topics, setTopics] = useState<TopicRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/graph/tag-groups")
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((data: { tags?: TopicRow[] }) => {
        if (!cancelled) setTopics(data.tags ?? []);
      })
      .catch(() => {
        if (!cancelled) setTopics([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (topics === null) {
    return <p className="px-2 py-2 font-mono text-[10.5px] text-ink-soft/50">loading topics…</p>;
  }
  if (topics.length === 0) {
    return <p className="px-2 py-2 font-mono text-[10.5px] text-ink-soft/50">no topics yet</p>;
  }
  return (
    <nav aria-label="Browse by topic">
      {topics.map((t) => (
        <Link
          key={t.tag}
          // Text-query bridge into the proposals explorer (no tag facet on the
          // index — precise faceting is a flagged follow-up).
          href={`/search?scope=legislation/proposals&q=${encodeURIComponent(t.tag)}`}
          className="flex items-center gap-2 rounded-[2px] px-2 py-[3px] font-mono text-[12px] text-ink-soft transition-colors hover:bg-ink/5 hover:text-amber focus-visible:outline-none focus-visible:text-accent"
        >
          <span className="min-w-0 flex-1 truncate">
            {t.icon ? `${t.icon} ` : ""}{t.label}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-soft/60">
            {formatCountCompact(t.count)}
          </span>
        </Link>
      ))}
    </nav>
  );
}
