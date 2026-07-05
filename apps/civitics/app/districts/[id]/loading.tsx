export default function DistrictLoading() {
  return (
    <div className="min-h-screen bg-paper-2">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-2 h-8 w-64 animate-pulse rounded bg-rule/40" />
        <div className="mb-6 h-4 w-96 max-w-full animate-pulse rounded bg-rule/40" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="h-96 animate-pulse border border-rule bg-card" />
          </div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-32 animate-pulse border border-rule bg-card"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
