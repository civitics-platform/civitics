// QWEN-ADDED: skeleton loading state for proposals list (Next.js Suspense fallback)
export default function ProposalsLoading() {
  return (
    <div className="min-h-screen bg-paper">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-6 h-8 w-48 animate-pulse bg-rule/50" />
        {/* Featured section */}
        <div className="mb-8 h-40 animate-pulse border border-rule bg-card" />
        {/* Filter bar */}
        <div className="mb-6 flex gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-9 w-32 animate-pulse bg-rule/50" />
          ))}
        </div>
        {/* Proposals grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-48 animate-pulse border border-rule bg-card"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
