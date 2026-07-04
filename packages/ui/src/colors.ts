// Token-native party classes (FIX-729). The Badge component variants are the
// reference implementation; wine (viz-7) stands in for independents — the
// token system has no purple. For color VALUES (SVG/canvas/d3), the canonical
// map is PARTY_COLORS in @civitics/graph (rgb(var(--c-x)) strings).
// Amber contrast rule: "other" uses bg-amber/20 + text-ink tints — bare amber
// text is unreadable on paper.
export const PARTY_COLORS = {
  democrat: {
    text: "text-civic-blue",
    bg: "bg-civic-blue/10",
    border: "border-civic-blue/25",
    dot: "bg-civic-blue",
    badge: "bg-civic-blue/10 text-civic-blue",
  },
  republican: {
    text: "text-accent",
    bg: "bg-accent/10",
    border: "border-accent/25",
    dot: "bg-accent",
    badge: "bg-accent/10 text-accent",
  },
  independent: {
    text: "text-viz-7",
    bg: "bg-viz-7/10",
    border: "border-viz-7/25",
    dot: "bg-viz-7",
    badge: "bg-viz-7/10 text-viz-7",
  },
  other: {
    text: "text-ink",
    bg: "bg-amber/20",
    border: "border-amber/40",
    dot: "bg-amber",
    badge: "bg-amber/20 text-ink",
  },
} as const;
