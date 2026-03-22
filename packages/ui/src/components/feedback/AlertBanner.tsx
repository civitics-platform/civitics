import * as React from "react";

interface AlertBannerProps {
  level: "info" | "warning" | "error" | "success";
  message: string;
  detail?: string;
  dismissible?: boolean;
  onDismiss?: () => void;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const levelStyles: Record<
  AlertBannerProps["level"],
  { bg: string; border: string; text: string; icon: string }
> = {
  info: {
    bg: "bg-blue-50",
    border: "border-blue-200",
    text: "text-blue-800",
    icon: "ℹ",
  },
  warning: {
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-800",
    icon: "⚠",
  },
  error: {
    bg: "bg-red-50",
    border: "border-red-200",
    text: "text-red-800",
    icon: "✗",
  },
  success: {
    bg: "bg-green-50",
    border: "border-green-200",
    text: "text-green-800",
    icon: "✓",
  },
};

export function AlertBanner({
  level,
  message,
  detail,
  dismissible,
  onDismiss,
  action,
}: AlertBannerProps) {
  const styles = levelStyles[level];

  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${styles.bg} ${styles.border}`}
      role="alert"
    >
      <span className={`text-sm font-medium mt-0.5 ${styles.text}`} aria-hidden="true">
        {styles.icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${styles.text}`}>{message}</p>
        {detail && (
          <p className={`mt-0.5 text-xs ${styles.text} opacity-80`}>{detail}</p>
        )}
        {action && (
          <button
            onClick={action.onClick}
            className={`mt-2 text-xs font-semibold underline ${styles.text}`}
          >
            {action.label}
          </button>
        )}
      </div>
      {dismissible && (
        <button
          onClick={onDismiss}
          className={`shrink-0 text-sm ${styles.text} opacity-60 hover:opacity-100 transition-opacity duration-150`}
          aria-label="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  );
}
