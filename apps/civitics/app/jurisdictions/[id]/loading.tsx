export default function JurisdictionLoading() {
  return (
    <div className="min-h-screen bg-paper-2">
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {/* Header */}
        <div className="border border-rule bg-card p-6">
          <div className="h-3 w-32 animate-pulse rounded bg-paper-2" />
          <div className="mt-3 h-7 w-1/2 animate-pulse rounded bg-rule/40" />
          <div className="mt-3 h-3 w-1/3 animate-pulse rounded bg-paper-2" />
        </div>
        {/* Map */}
        <div className="mt-4 h-72 animate-pulse border border-rule bg-card" />
        {/* Sections */}
        {[1, 2, 3].map((i) => (
          <div key={i} className="mt-8">
            <div className="mb-3 h-5 w-40 animate-pulse rounded bg-rule/40" />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="h-24 animate-pulse border border-rule bg-card" />
              <div className="h-24 animate-pulse border border-rule bg-card" />
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}
