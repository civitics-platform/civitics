export default function DashboardLoading() {
  // Same terminal scope as page.tsx (FIX-720) so there is no paper→dark flash
  // while the dashboard streams in — the skeleton is dark from first paint.
  return (
    <div data-theme="terminal" className="min-h-screen bg-paper text-ink">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-3 h-3 w-56 animate-pulse rounded bg-rule/50" />
        <div className="mb-2 h-8 w-72 animate-pulse rounded bg-rule/60" />
        <div className="mb-6 h-4 w-[28rem] max-w-full animate-pulse rounded bg-rule/40" />
        <div className="mb-6 h-9 w-72 animate-pulse rounded-md bg-rule/40" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-xl border border-rule bg-card"
            />
          ))}
        </div>
        <div className="mt-6 h-64 animate-pulse rounded-xl border border-rule bg-card" />
        <div className="mt-6 h-48 animate-pulse rounded-xl border border-rule bg-card" />
      </div>
    </div>
  );
}
