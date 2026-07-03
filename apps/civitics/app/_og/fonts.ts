// Request-time font loader for the dynamic OG routes (FIX-714).
//
// ImageResponse (satori) needs raw font data. We load committed .woff subsets
// (satori supports ttf/otf/woff — NOT woff2) from apps/civitics/assets/og via
// the `fetch(new URL(<static literal>, import.meta.url))` pattern: the Next
// bundler traces the literal and emits the woff as a static asset, and on the
// EDGE runtime fetch resolves that emitted path against the origin. (This is
// why the OG routes are edge, not nodejs — nodejs fetch rejects the emitted
// /_next/static path as a relative URL.) No Google Fonts fetch at request time;
// no new npm dependency.

type OgFont = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 500 | 600 | 700;
  style: "normal" | "italic";
};

export async function loadOgFonts(): Promise<OgFont[]> {
  const [fraunces, frauncesItalic, mono] = await Promise.all([
    fetch(new URL("../../assets/og/Fraunces-SemiBold.woff", import.meta.url)).then((r) =>
      r.arrayBuffer(),
    ),
    fetch(new URL("../../assets/og/Fraunces-Italic.woff", import.meta.url)).then((r) =>
      r.arrayBuffer(),
    ),
    fetch(new URL("../../assets/og/JetBrainsMono-Medium.woff", import.meta.url)).then((r) =>
      r.arrayBuffer(),
    ),
  ]);

  return [
    { name: "Fraunces", data: fraunces, weight: 600, style: "normal" },
    { name: "Fraunces", data: frauncesItalic, weight: 500, style: "italic" },
    { name: "JetBrains Mono", data: mono, weight: 500, style: "normal" },
  ];
}
