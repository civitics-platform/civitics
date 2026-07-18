/**
 * packages/graph/src/tokens.ts — FIX-729
 *
 * Bridge between the CSS design-token system (`--c-*` RGB channel triplets in
 * apps/civitics/app/globals.css) and JS color consumers in this package.
 *
 * Two consumption modes:
 *
 * 1. CSS contexts (HTML `style=` props, SVG `style` attribute): use the
 *    `rgb(var(--c-x))` strings stored in the palettes directly — the browser
 *    resolves them, and they re-bind per scope (paper page vs
 *    `data-theme="terminal"`). NOTE the Wave-1 SVG rule: `var()` fails in SVG
 *    *presentation attributes* (`fill="..."`), so in SVG either set via
 *    `style=` / d3 `.style()`, or resolve first (mode 2).
 *
 * 2. JS contexts (d3 `.attr()`, scale interpolators, `<input type="color">`,
 *    canvas): resolve to a concrete color at render time with
 *    `resolveToken`/`resolveColor`, passing an element INSIDE the consuming
 *    component so the value is scope-aware — a terminal-scoped graph resolves
 *    the luminous dark-mode values, a paper-page embed resolves ink values.
 *    Resolving concrete values also makes serialized-SVG export (screenshot
 *    PNG) safe, since custom properties don't survive XMLSerializer.
 *
 * Node FILLS are the deliberate exception: nodes are "paper records floating
 * on the dark instrument", so their fills resolve from `document.documentElement`
 * (`:root` = paper values) regardless of scope — pass no scope element (or
 * use `resolvePaperToken`) for those.
 */

const FALLBACK = "rgb(0, 0, 0)";

/**
 * Format a `--c-*` channel triplet (`"R G B"` as authored in globals.css) as a
 * COMMA-separated `rgb(R, G, B)` string. Comma form is valid CSS everywhere AND
 * parseable by d3-color; the CSS space form `rgb(R G B)` is browser-valid but
 * `d3.color()` returns null for it — which silently blackened every
 * d3-interpolated fill: `d3.color('rgb(43 74 139)')` → null, so
 * `interpolateRgb(...)` emitted `rgb(0, 0, 0)` (choropleth painted all-black —
 * FIX-860; also the treemap panel→stroke blend and sunburst `.darker()`).
 * Pure (no DOM) so the contract is unit-testable. Tolerates a comma- or
 * space-separated triplet.
 */
export function formatRgbTriplet(triplet: string): string {
  const channels = triplet.trim().split(/[\s,]+/).filter(Boolean);
  return channels.length ? `rgb(${channels.join(", ")})` : FALLBACK;
}

/** Resolve a `--c-*` token to a concrete `rgb(R, G, B)` string. SSR-safe. */
export function resolveToken(name: string, scope?: Element | null): string {
  if (typeof window === "undefined" || typeof document === "undefined") return FALLBACK;
  const el = scope ?? document.documentElement;
  const triplet = getComputedStyle(el).getPropertyValue(name).trim();
  return triplet ? formatRgbTriplet(triplet) : FALLBACK;
}

/** Paper-mode value of a token regardless of scope (node fills). */
export function resolvePaperToken(name: string): string {
  return resolveToken(name, null);
}

const VAR_RE = /^rgb\(\s*var\((--[a-z0-9-]+)\)\s*\)$/i;

/**
 * Resolve a palette color that may be an `rgb(var(--c-x))` token string, a
 * legacy/user-picked hex literal (saved sessions, custom connection colors),
 * or an already-concrete color. Returns a concrete CSS color usable in SVG
 * presentation attributes and canvas.
 */
export function resolveColor(color: string, scope?: Element | null): string {
  const m = color.match(VAR_RE);
  return m ? resolveToken(m[1]!, scope) : color;
}

/**
 * resolveColor + alpha. Replaces the legacy `hexColor + "33"` concat trick,
 * which silently produces an invalid color when the palette value is an
 * `rgb(var(--c-x))` string.
 */
export function withAlpha(color: string, alpha: number, scope?: Element | null): string {
  const resolved = resolveColor(color, scope);
  const rgbMatch = resolved.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const channels = rgbMatch[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");
    return `rgb(${channels} / ${alpha})`;
  }
  if (resolved.startsWith("#")) {
    const hex =
      resolved.length === 4
        ? resolved.slice(1).split("").map((c) => c + c).join("")
        : resolved.slice(1, 7);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return resolved;
    return `rgb(${r} ${g} ${b} / ${alpha})`;
  }
  return resolved;
}

/** Concrete `#rrggbb` (for `<input type="color">`, which rejects rgb()). */
export function toHexColor(color: string, scope?: Element | null): string {
  const resolved = resolveColor(color, scope);
  if (resolved.startsWith("#")) return resolved.slice(0, 7);
  const m = resolved.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return "#000000";
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return "#000000";
  return (
    "#" +
    parts
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  );
}
