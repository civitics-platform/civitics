import { createAdminClient } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ code: string }>;
}

export default async function EmbedPage({ params }: Props) {
  const { code } = await params;

  const supabase = createAdminClient();
  const { data: snapshot } = await withDbTimeout(
    supabase
      .from("graph_snapshots")
      .select("*")
      .eq("code", code)
      .maybeSingle(),
    3000,
    "graph-embed:snapshot",
  );

  if (!snapshot) notFound();

  // Update view count
  await supabase
    .from("graph_snapshots")
    .update({ view_count: (snapshot.view_count ?? 0) + 1 })
    .eq("code", code);

  return (
    <div data-theme="terminal" className="flex flex-col h-screen bg-paper text-ink overflow-hidden">
      {/* Minimal chrome — just the graph */}
      <div className="flex-1 relative overflow-hidden">
        {/* Placeholder for the embedded graph */}
        <div className="w-full h-full flex items-center justify-center text-ink-soft/60">
          <div className="text-center">
            <div className="text-lg font-semibold text-ink mb-2">
              {(snapshot as { title?: string }).title ?? `Graph ${code}`}
            </div>
            <div className="text-sm text-ink-soft/60">Embedded graph</div>
          </div>
        </div>

        {/* Watermark */}
        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          <a
            href={`https://civitics.com/graph/${code}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 bg-card/90 border border-rule rounded px-2.5 py-1.5 text-xs text-accent hover:text-accent/80 transition-colors"
          >
            <span className="font-medium">Civitics</span>
            <span className="text-ink-soft/60">↗</span>
          </a>
        </div>
      </div>
    </div>
  );
}
