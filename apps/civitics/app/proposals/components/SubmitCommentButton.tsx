"use client";

type Props = {
  regulationsGovId: string | null;
  congressGovUrl: string | null;
  size?: "sm" | "md" | "lg";
  stopPropagation?: boolean;
};

export function SubmitCommentButton({
  regulationsGovId,
  congressGovUrl,
  size = "md",
  stopPropagation = false,
}: Props) {
  const href = regulationsGovId
    ? `https://www.regulations.gov/commenton/${regulationsGovId}`
    : congressGovUrl ?? null;

  if (!href) return null;

  const sizeClass =
    size === "lg"
      ? "px-6 py-3 text-base"
      : size === "sm"
      ? "px-3 py-1.5 text-xs"
      : "px-4 py-2 text-sm";

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
      className={`inline-flex items-center gap-1.5 rounded-md bg-indigo-600 font-medium text-white hover:bg-indigo-700 transition-colors ${sizeClass}`}
    >
      Submit Comment at Regulations.gov
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-3.5 w-3.5 opacity-75"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z"
          clipRule="evenodd"
        />
        <path
          fillRule="evenodd"
          d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z"
          clipRule="evenodd"
        />
      </svg>
    </a>
  );
}
