export default function OfficialDetailLoading() {
  return (
    <div className="min-h-screen bg-paper">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center gap-4">
          {/* avatar placeholder stays round — the real header avatar is circular */}
          <div className="h-20 w-20 animate-pulse rounded-full bg-rule/50" />
          <div className="flex-1 space-y-2">
            <div className="h-7 w-64 animate-pulse bg-rule/50" />
            <div className="h-4 w-48 animate-pulse bg-rule/50" />
            <div className="h-4 w-72 animate-pulse bg-rule/50" />
          </div>
        </div>
        <div className="mb-6 flex gap-2 border-b border-rule">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-9 w-24 animate-pulse bg-rule/50" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-48 animate-pulse border border-rule bg-card"
              />
            ))}
          </div>
          <div className="space-y-4">
            <div className="h-48 animate-pulse border border-rule bg-card" />
            <div className="h-32 animate-pulse border border-rule bg-card" />
          </div>
        </div>
      </div>
    </div>
  );
}
