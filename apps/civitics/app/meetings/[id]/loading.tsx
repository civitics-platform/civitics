export default function MeetingDetailLoading() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <div className="mb-4 h-4 w-48 animate-pulse rounded bg-gray-200" />
          <div className="mb-3 flex gap-2">
            <div className="h-6 w-20 animate-pulse rounded bg-gray-100" />
            <div className="h-6 w-24 animate-pulse rounded bg-gray-100" />
          </div>
          <div className="h-9 w-2/3 animate-pulse rounded bg-gray-200" />
          <div className="mt-3 h-5 w-1/2 animate-pulse rounded bg-gray-100" />
        </div>
      </div>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-4 h-6 w-32 animate-pulse rounded bg-gray-200" />
        <div className="space-y-3">
          <div className="h-20 animate-pulse rounded-lg border border-gray-200 bg-white" />
          <div className="h-20 animate-pulse rounded-lg border border-gray-200 bg-white" />
          <div className="h-20 animate-pulse rounded-lg border border-gray-200 bg-white" />
        </div>
      </div>
    </div>
  );
}
