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
    <div className="flex flex-col h-screen bg-gray-950 overflow-hidden">
      {/* Minimal chrome — just the graph */}
      <div className="flex-1 relative overflow-hidden">
        {/* Placeholder for the embedded graph */}
        <div className="w-full h-full flex items-center justify-center text-gray-600">
          <div className="text-center">
            <div className="text-lg font-semibold text-gray-400 mb-2">
              {(snapshot as { title?: string }).title ?? `Graph ${code}`}
            </div>
            <div className="text-sm text-gray-600">Embedded graph</div>
          </div>
        </div>

        {/* Watermark */}
        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          <a
            href={`https://civitics.com/graph/${code}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 bg-gray-900/90 border border-gray-800 rounded px-2.5 py-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            <span className="font-medium">Civitics</span>
            <span className="text-gray-600">↗</span>
          </a>
        </div>
      </div>
    </div>
  );
}
