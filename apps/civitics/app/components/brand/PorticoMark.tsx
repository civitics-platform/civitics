/**
 * PorticoMark — primary brand mark ("Portico Barcode", logo concept №1).
 * A government portico whose columns are a barcode: government, scanned and
 * accounted for. currentColor-driven so it inherits text color in both paper
 * and terminal scopes. Legible down to 16px (favicon scale).
 */
export function PorticoMark({
  size = 32,
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
      <path
        d="M6 24 L32 7 L58 24 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinejoin="round"
      />
      <g fill="currentColor">
        <rect x="12" y="29" width="3.5" height="22" />
        <rect x="19" y="29" width="6" height="22" />
        <rect x="29" y="29" width="2.5" height="22" />
        <rect x="35" y="29" width="7" height="22" />
        <rect x="46" y="29" width="3" height="22" />
        <rect x="52" y="29" width="1.5" height="22" />
        <rect x="8" y="54" width="48" height="3.5" />
      </g>
    </svg>
  );
}
