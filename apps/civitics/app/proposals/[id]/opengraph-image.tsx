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

// Dynamic OG card for a proposal (FIX-714). Mirrors the officials route: edge
// runtime (for the font fetch), ONE cheap indexed publishable-key read, Next's
// default immutable client cache (see _og/cards.ts caching note), try/catch +
// withDbTimeout falling back to the static brand card on any error.
export const runtime = "edge";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Civitics — the public ledger";

const TYPE_LABEL: Record<string, string> = {
  regulation: "Federal Regulation",
  bill: "Congressional Bill",
  executive_order: "Executive Order",
  treaty: "Treaty",
  referendum: "Referendum",
  resolution: "Resolution",
};

const STATUS_LABEL: Record<string, string> = {
  open_comment: "Open for Comment",
  introduced: "Introduced",
  in_committee: "In Committee",
  passed_committee: "Passed Committee",
  floor_vote: "Floor Vote",
  passed_chamber: "Passed Chamber",
  passed_both_chambers: "Passed Both Chambers",
  signed: "Signed",
  enacted: "Enacted",
  failed: "Failed",
  withdrawn: "Withdrawn",
  comment_closed: "Comment Closed",
};

export default async function ProposalOgImage({
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
        .from("proposals")
        .select("title, type, status, metadata")
        .eq("id", params.id)
        .single(),
      3000,
      "og:proposal",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as { data: any };

    if (!data?.title) {
      return new ImageResponse(BrandCard(), { ...OG_SIZE, fonts });
    }

    const agency = (data.metadata as Record<string, string> | null)?.agency_id ?? null;
    const kicker = upperKicker([
      TYPE_LABEL[data.type] ?? data.type,
      agency,
      STATUS_LABEL[data.status] ?? data.status,
    ]);

    return new ImageResponse(
      RecordCard({ kicker: kicker || "PUBLIC RECORD", title: clampTitle(String(data.title)) }),
      { ...OG_SIZE, fonts },
    );
  } catch {
    return new ImageResponse(BrandCard(), { ...OG_SIZE, fonts });
  }
}
