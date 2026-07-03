// Shared OG-card element builders (FIX-714).
//
// Used by BOTH the request-time dynamic routes (officials/[id], proposals/[id]
// opengraph-image.tsx) AND the one-off static-default generator
// (scripts/og/generate-static-og.mjs). Written with React.createElement rather
// than JSX so the exact same module runs under the Next bundler and under a
// plain `tsx` node script without any JSX-transform config drift.
//
// satori (inside next/og) constraints honoured here:
//   • every container is an explicit flex box with concrete hex colors
//   • brand marks are inlined as data-URI <img> (satori's most reliable path
//     for our stroked SVG marks) rather than React SVG components
//   • text is pre-uppercased instead of relying on text-transform

import { createElement as h, type ReactElement } from "react";

// 1.91:1 — the standard OG / Twitter summary-large-image frame.
export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

// Caching note (FIX-714): the OG cost defense against a crawl (June incident)
// is Next's own default header on these dynamic metadata-image routes —
// `Cache-Control: public, immutable, no-transform, max-age=31536000`. That is
// the browser/crawler-facing value, so a crawler caches the card for a year and
// never refetches. We deliberately do NOT pass a Cache-Control to ImageResponse:
// Next's metadata-image handler stamps its own Cache-Control / CDN-Cache-Control
// and a passed header only *appends* (duplicate directives, first wins), it does
// not replace — so a "clean s-maxage=604800" is not achievable this way and the
// attempt just produced a messy double header. Next's edge CDN default
// (s-maxage=300 + stale-while-revalidate=600) bounds origin renders and, with
// swr, never makes a crawler wait. Net: immutable at the client, swr at the CDN.

// Brand palette — concrete hex mirrors of the globals.css --c-* paper tokens
// (satori can't read CSS custom properties).
const PAPER = "#f7f4ed";
const INK = "#1c1a16";
const INK_SOFT = "#57534a";
const RULE = "#d8d2c4";
const ACCENT = "#9d2b2b";

function porticoSvg(color: string, size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><path d="M6 24 L32 7 L58 24 Z" fill="none" stroke="${color}" stroke-width="3.5" stroke-linejoin="round"/><g fill="${color}"><rect x="12" y="29" width="3.5" height="22"/><rect x="19" y="29" width="6" height="22"/><rect x="29" y="29" width="2.5" height="22"/><rect x="35" y="29" width="7" height="22"/><rect x="46" y="29" width="3" height="22"/><rect x="52" y="29" width="1.5" height="22"/><rect x="8" y="54" width="48" height="3.5"/></g></svg>`;
}

function stampSvg(color: string, size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><g transform="rotate(-6 32 32)"><rect x="10" y="10" width="44" height="44" fill="none" stroke="${color}" stroke-width="3"/><rect x="16" y="16" width="32" height="32" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M24 33 L30 39 L41 26" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
}

function dataUri(svg: string): string {
  // utf8 data URI (not base64) so the encoder is runtime-agnostic — the OG
  // routes run on the edge runtime, which has no Node `Buffer`.
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ── Site-wide default: receipt-motif brand card ─────────────────────────────
// The static app/opengraph-image.png and every dynamic route's error fallback.
export function BrandCard(): ReactElement {
  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: PAPER,
        color: INK,
        padding: 64,
      },
    },
    h("div", { style: { display: "flex", height: 6, background: INK } }),
    h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          alignItems: "center",
          justifyContent: "center",
        },
      },
      h("img", { width: 128, height: 128, src: dataUri(porticoSvg(INK, 128)) }),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginTop: 26,
            fontFamily: "Fraunces",
            fontWeight: 600,
            fontSize: 94,
            letterSpacing: 10,
          },
        },
        "CIVITICS",
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginTop: 6,
            fontFamily: "JetBrains Mono",
            fontSize: 26,
            letterSpacing: 12,
            color: INK_SOFT,
          },
        },
        "THE PUBLIC LEDGER",
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginTop: 30,
            fontFamily: "Fraunces",
            fontStyle: "italic",
            fontSize: 40,
          },
        },
        "Democracy, with receipts.",
      ),
    ),
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `2px solid ${RULE}`,
          paddingTop: 20,
          fontFamily: "JetBrains Mono",
          fontSize: 23,
          letterSpacing: 1,
        },
      },
      h("div", { style: { display: "flex", color: INK_SOFT } }, "civitics.com"),
      h("div", { style: { display: "flex", color: ACCENT } }, "$0.00 — always"),
    ),
  );
}

// ── Entity card: officials/[id] + proposals/[id] ────────────────────────────
export function RecordCard({
  kicker,
  title,
}: {
  kicker: string;
  title: string;
}): ReactElement {
  // Scale the name/title to the frame so both a short senator name and a long
  // bill title stay on-card without overflow.
  const len = title.length;
  const titleSize =
    len <= 34 ? 78 : len <= 60 ? 62 : len <= 100 ? 48 : len <= 150 ? 38 : 32;

  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: PAPER,
        color: INK,
        padding: 64,
      },
    },
    // Letterhead
    h(
      "div",
      { style: { display: "flex", alignItems: "center" } },
      h("img", { width: 40, height: 40, src: dataUri(stampSvg(INK, 40)) }),
      h(
        "div",
        {
          style: {
            display: "flex",
            marginLeft: 14,
            fontFamily: "JetBrains Mono",
            fontSize: 20,
            letterSpacing: 6,
            color: INK_SOFT,
          },
        },
        "CIVITICS · THE PUBLIC LEDGER",
      ),
    ),
    // Body
    h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          justifyContent: "center",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            fontFamily: "JetBrains Mono",
            fontSize: 24,
            letterSpacing: 3,
            color: ACCENT,
            marginBottom: 22,
          },
        },
        kicker,
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            fontFamily: "Fraunces",
            fontWeight: 600,
            fontSize: titleSize,
            lineHeight: 1.08,
          },
        },
        title,
      ),
    ),
    // Receipt-rule footer
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `2px solid ${RULE}`,
          paddingTop: 20,
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            fontFamily: "Fraunces",
            fontStyle: "italic",
            fontSize: 24,
            color: INK_SOFT,
          },
        },
        "Civitics — democracy, with receipts.",
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            fontFamily: "JetBrains Mono",
            fontSize: 22,
            color: ACCENT,
          },
        },
        "$0.00 — always",
      ),
    ),
  );
}

// Trim an overlong title to keep the card legible; the ellipsis reads as
// truncation, not data loss.
export function clampTitle(s: string, max = 155): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function upperKicker(parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => Boolean(p && p.trim()))
    .join("  ·  ")
    .toUpperCase();
}
