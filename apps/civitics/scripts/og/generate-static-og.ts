// One-off generator for the site-wide static default OG card (FIX-714).
//
//   cd apps/civitics && pnpm exec tsx scripts/og/generate-static-og.ts
//
// Renders the receipt-motif brand card (shared BrandCard builder) to a PNG and
// writes it to apps/civitics/app/opengraph-image.png, which Next serves as the
// default openGraph/twitter image for every route that doesn't define its own
// opengraph-image. Cost-conscious by design: the default card is a committed
// static file, not a per-request render (only officials/[id] + proposals/[id]
// render dynamically). Re-run this script and commit the PNG to change the card.
//
// Lives under apps/civitics so `next/og` + `react` resolve from the app's
// node_modules (they are not hoisted to the repo root under pnpm).

import { readFileSync, writeFileSync } from "node:fs";
import { ImageResponse } from "next/og";
import { BrandCard, OG_SIZE } from "../../app/_og/cards";

const fontsDir = new URL("../../assets/og/", import.meta.url);
const font = (file: string) => readFileSync(new URL(file, fontsDir));

const fonts = [
  { name: "Fraunces", data: font("Fraunces-SemiBold.woff"), weight: 600 as const, style: "normal" as const },
  { name: "Fraunces", data: font("Fraunces-Italic.woff"), weight: 500 as const, style: "italic" as const },
  { name: "JetBrains Mono", data: font("JetBrainsMono-Medium.woff"), weight: 500 as const, style: "normal" as const },
];

async function main() {
  const img = new ImageResponse(BrandCard(), { ...OG_SIZE, fonts });
  const png = Buffer.from(await img.arrayBuffer());

  const out = new URL("../../app/opengraph-image.png", import.meta.url);
  writeFileSync(out, png);

  console.log(`wrote ${png.length} bytes -> apps/civitics/app/opengraph-image.png`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
