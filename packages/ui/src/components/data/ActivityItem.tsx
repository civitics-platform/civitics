import * as React from "react";
import { formatRelativeTime } from "../../utils";

interface ActivityItemProps {
  icon?: string;
  title: string;
  subtitle?: string;
  timestamp?: string;
  href?: string;
  meta?: string;
}

function Inner({ icon, title, subtitle, timestamp, meta }: ActivityItemProps) {
  return (
    <div className="flex items-start gap-3 py-3">
      {icon && (
        <span
          className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full bg-paper-2 text-base"
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink truncate">{title}</p>
        {subtitle && (
          <p className="text-xs text-ink-soft truncate">{subtitle}</p>
        )}
        {meta && <p className="text-xs text-ink-soft/80">{meta}</p>}
      </div>
      {timestamp && (
        <span className="shrink-0 text-xs text-ink-soft/80">
          {formatRelativeTime(timestamp)}
        </span>
      )}
    </div>
  );
}

export function ActivityItem(props: ActivityItemProps) {
  if (props.href) {
    return (
      <a
        href={props.href}
        className="block hover:bg-ink/5 transition-colors duration-150 rounded-lg -mx-2 px-2"
      >
        <Inner {...props} />
      </a>
    );
  }
  return <Inner {...props} />;
}
