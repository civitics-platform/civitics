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
  // Warning text stays ink — amber text is unreadable on paper; the amber
  // border/tint carries the semantics in both modes (FIX-719).
  info: {
    bg: "bg-civic-blue/10",
    border: "border-civic-blue/30",
    text: "text-civic-blue",
    icon: "ℹ",
  },
  warning: {
    bg: "bg-amber/15",
    border: "border-amber/60",
    text: "text-ink",
    icon: "⚠",
  },
  error: {
    bg: "bg-accent/10",
    border: "border-accent/30",
    text: "text-accent",
    icon: "✗",
  },
  success: {
    bg: "bg-green-ink/10",
    border: "border-green-ink/30",
    text: "text-green-ink",
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
