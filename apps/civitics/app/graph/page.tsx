import { GraphPage } from "./GraphPage";
import { PageViewTracker } from "../components/PageViewTracker";

// No SSR data-fetching; the graph payload is fetched client-side from the
// /api/graph/* routes which have their own cache rules. Letting Next.js
// statically render the shell drops TTFB to a CDN hit.
export const dynamic = "force-static";

export const metadata = {
  title: "Connection Graph",
  description: "Explore connections between officials, agencies, and legislation.",
};

export default function Page() {
  const aiEnabled = process.env["AI_NARRATIVE_ENABLED"] !== "false";
  return (
    <>
      <PageViewTracker entityType="graph" />
      <GraphPage aiEnabled={aiEnabled} />
    </>
  );
}
