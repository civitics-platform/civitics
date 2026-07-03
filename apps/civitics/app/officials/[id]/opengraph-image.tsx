import { ImageResponse } from "next/og";
import { createClient } from "@supabase/supabase-js";
import { withDbTimeout } from "@/lib/supabase-check";
import {
  BrandCard,
  RecordCard,
  OG_SIZE,
  OG_CONTENT_TYPE,
  clampTitle,
  upperKicker,
} from "../../_og/cards";
import { loadOgFonts } from "../../_og/fonts";

// Dynamic OG card for an official (FIX-714). Edge runtime — the only runtime
// where ImageResponse's `fetch(new URL(font, import.meta.url))` font load
// resolves (nodejs fetch rejects the emitted /_next/static path as relative).
//
// ONE cheap indexed publishable-key read (anon RLS client, never the secret
// key / createAdminClient); crawl cost is bounded by Next's default immutable
// client cache (see the caching note in _og/cards.ts); and a try/catch +
// withDbTimeout falls back to the static brand card on any error — the same
// defensive contract as generateStaticParams.
export const runtime = "edge";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Civitics — the public ledger";

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default async function OfficialOgImage({
  params,
}: {
  params: { id: string };
}) {
  const fonts = await loadOgFonts();

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    );
    const { data } = (await withDbTimeout(
      supabase
        .from("officials")
        .select("full_name, role_title, party, district_name, jurisdictions!jurisdiction_id(name)")
        .eq("id", params.id)
        .single(),
      3000,
      "og:official",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as { data: any };

    if (!data?.full_name) {
      return new ImageResponse(BrandCard(), { ...OG_SIZE, fonts });
    }

    const stateName = data.jurisdictions?.name ?? data.district_name ?? null;
    const kicker = upperKicker([
      data.role_title,
      data.party ? cap(String(data.party)) : null,
      stateName,
    ]);

    return new ImageResponse(
      RecordCard({ kicker: kicker || "PUBLIC OFFICIAL", title: clampTitle(String(data.full_name)) }),
      { ...OG_SIZE, fonts },
    );
  } catch {
    // DB unavailable / bad id / any render error → brand card, still cached.
    return new ImageResponse(BrandCard(), { ...OG_SIZE, fonts });
  }
}
