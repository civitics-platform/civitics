// QWEN-ADDED: skeleton loading state for initiatives list (Next.js Suspense fallback)
export default function InitiativesLoading() {
  return (
    <div className="min-h-screen bg-paper-2">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 h-8 w-48 animate-pulse rounded bg-rule/40" />
        <div className="mb-6 h-4 w-64 animate-pulse rounded bg-paper-2" />
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-rule bg-card"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
