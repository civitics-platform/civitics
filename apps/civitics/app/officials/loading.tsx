// QWEN-ADDED: skeleton loading state for officials list (Next.js Suspense fallback)
export default function OfficialsLoading() {
  return (
    <div className="min-h-screen bg-paper">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Page header skeleton */}
        <div className="mb-6 h-8 w-48 animate-pulse bg-rule/50" />
        <div className="mb-6 h-4 w-96 animate-pulse bg-rule/50" />
        {/* Filter bar skeleton */}
        <div className="mb-6 flex gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-9 w-28 animate-pulse bg-rule/50" />
          ))}
        </div>
        {/* Two-column layout: list + detail panel */}
        <div className="flex gap-6">
          <div className="flex-1 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-32 animate-pulse border border-rule bg-card"
              />
            ))}
          </div>
          <div className="hidden h-96 w-96 animate-pulse border border-rule bg-card lg:block" />
        </div>
      </div>
    </div>
  );
}
