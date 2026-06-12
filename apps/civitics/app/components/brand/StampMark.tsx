/**
 * StampMark — secondary badge mark ("The Stamp", logo concept №5).
 * Rotated double-square stamp with a check: the "verified / on the record"
 * action mark. Reserved for verification badges, evidence-card stamps, and
 * "comment filed" receipts in later phases. currentColor-driven.
 */
export function StampMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={className}
    >
      <g transform="rotate(-6 32 32)">
        <rect
          x="10"
          y="10"
          width="44"
          height="44"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
        />
        <rect
          x="16"
          y="16"
          width="32"
          height="32"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        />
        <path
          d="M24 33 L30 39 L41 26"
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
