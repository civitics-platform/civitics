"use client";

/**
 * FIX-400 — click-through source detail panel for SourceBadge.
 *
 * Wraps the server-rendered SourceBadge as `children` so the badge stays a
 * pure presentational component (FIX-399's no-hydration-flash decision is
 * preserved). The trigger is a `<span role="button">` rather than a real
 * `<button>` because SourceBadge already renders an `<a target="_blank">`
 * internally and `<button><a/></button>` is invalid HTML — we intercept the
 * bubble-phase click with preventDefault to stop navigation and open the
 * popover instead.
 *
 * Renders nothing interactive when `attribution.primary` is null — the
 * badge would render null anyway, and an empty popover trigger would be
 * confusing. Lazy-fetches `attribution.detail_endpoint` on first open only;
 * caches the result for subsequent opens.
 *
 * Closes on Escape, click-outside, and when the trigger itself is clicked
 * again. Panel positions absolutely below the trigger with a max-width so
 * it doesn't overflow on mobile.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  resolveSource,
  type AttributionShape,
  type AttributionDetailResponse,
  type AttributionDetailSource,
  type AttributionEntityType,
  type SourceCategory,
} from "@civitics/db";

const SOURCE_CATEGORY_COLORS: Record<SourceCategory, string> = {
  federal:   "bg-blue-100 text-blue-800",
  state:     "bg-purple-100 text-purple-800",
  local:     "bg-green-100 text-green-800",
  community: "bg-amber-100 text-amber-800",
  other:     "bg-gray-100 text-gray-700",
};

type Props = {
  entityType: AttributionEntityType;
  entityId: string;
  attribution: AttributionShape | null | undefined;
  children: React.ReactNode;
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function SourceDetailPopover({ entityType: _entityType, entityId: _entityId, attribution, children }: Props) {
  // Hooks must run unconditionally — the null-primary early return happens
  // AFTER hook calls to satisfy rules-of-hooks even though `attribution`
  // never actually changes between renders in practice.
  const [open, setOpen]                       = useState(false);
  const [detail, setDetail]                   = useState<AttributionDetailResponse | null>(null);
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState<string | null>(null);
  const triggerRef                            = useRef<HTMLSpanElement | null>(null);
  const panelRef                              = useRef<HTMLDivElement | null>(null);
  const panelId                               = useId();

  const detailEndpoint = attribution?.detail_endpoint ?? null;
  const hasPrimary     = !!(attribution && attribution.primary);

  const handleOpen = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  // Lazy-fetch on first open. Cache afterward — don't refetch on subsequent
  // toggles. If the fetch fails, allow a retry (clear the error on next open).
  useEffect(() => {
    if (!open) return;
    if (!detailEndpoint) return;
    if (detail !== null) return;
    if (loading) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(detailEndpoint, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as AttributionDetailResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setDetail(body);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, detailEndpoint, detail, loading]);

  // Escape closes; click outside closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  // No popover trigger when there's no primary source — render badge as-is
  // (which itself renders null when primary is null).
  if (!hasPrimary || !attribution) {
    return <>{children}</>;
  }

  return (
    <span className="relative inline-block">
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        className="inline-flex cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 rounded-full"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleOpen();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleOpen();
          }
        }}
      >
        {children}
      </span>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Source details"
          className="absolute left-0 top-full z-30 mt-2 w-[20rem] max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-lg sm:w-80"
        >
          <SourceDetailContent loading={loading} error={error} detail={detail} fallback={attribution} />
          <div className="mt-3 border-t border-gray-100 pt-2 flex justify-between items-center gap-2">
            <a
              href="/about/sources"
              className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors"
            >
              About our sources →
            </a>
            <button
              type="button"
              onClick={() => { setOpen(false); triggerRef.current?.focus(); }}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              aria-label="Close source details"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

function SourceDetailContent({
  loading, error, detail, fallback,
}: {
  loading: boolean;
  error: string | null;
  detail: AttributionDetailResponse | null;
  fallback: AttributionShape;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span className="h-2 w-2 animate-pulse rounded-full bg-gray-300" aria-hidden />
        Loading source detail…
      </div>
    );
  }
  if (error) {
    // Fallback to the primary-only attribution shape that's already in scope.
    return (
      <>
        <div className="text-xs text-amber-700 mb-2">
          Could not load full source list ({error}). Showing primary source only.
        </div>
        <SourceRow source={fallback.primary!.source} source_url={fallback.primary!.source_url} last_seen_at={fallback.primary!.last_seen_at} is_primary />
      </>
    );
  }
  if (!detail) return null;

  if (detail.sources.length === 0) {
    return (
      <div className="text-xs text-gray-500">
        No source bindings recorded for this entity.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {detail.source_count === 1 ? "Source" : `${detail.source_count} sources`}
        </h2>
      </div>
      <ul className="flex flex-col gap-3">
        {detail.sources.map((s) => (
          <li key={`${s.source}:${s.external_id}`}>
            <SourceRow
              source={s.source}
              source_url={s.source_url}
              last_seen_at={s.last_seen_at}
              is_primary={s.is_primary}
              external_id={s.external_id}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceRow({
  source, source_url, last_seen_at, is_primary, external_id,
}: Pick<AttributionDetailSource, "source" | "source_url" | "last_seen_at"> & {
  is_primary?: boolean;
  external_id?: string;
}) {
  const resolved = resolveSource(source);
  const colorClass = SOURCE_CATEGORY_COLORS[resolved.category];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${colorClass}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
          {resolved.label}
        </span>
        {is_primary && (
          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            primary
          </span>
        )}
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-gray-400">License</dt>
        <dd className="text-gray-700">
          {resolved.license ? (
            resolved.license_url ? (
              <a
                href={resolved.license_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:text-indigo-800 underline-offset-2 hover:underline"
              >
                {resolved.license}
              </a>
            ) : (
              <span>{resolved.license}</span>
            )
          ) : resolved.license_url ? (
            <a
              href={resolved.license_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 hover:text-indigo-800 underline-offset-2 hover:underline"
            >
              See {resolved.label} terms
            </a>
          ) : (
            <span className="text-gray-400">Not specified</span>
          )}
        </dd>
        {source_url && (
          <>
            <dt className="text-gray-400">Link</dt>
            <dd>
              <a
                href={source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:text-indigo-800 underline-offset-2 hover:underline break-all"
              >
                View on {resolved.label} ↗
              </a>
            </dd>
          </>
        )}
        {last_seen_at && (
          <>
            <dt className="text-gray-400">Last seen</dt>
            <dd className="text-gray-700">{formatDate(last_seen_at)}</dd>
          </>
        )}
        {external_id && (
          <>
            <dt className="text-gray-400">ID</dt>
            <dd className="text-gray-500 font-mono text-[11px] break-all">{external_id}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
