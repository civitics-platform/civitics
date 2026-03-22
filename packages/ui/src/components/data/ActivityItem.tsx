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
          className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-base"
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{title}</p>
        {subtitle && (
          <p className="text-xs text-gray-500 truncate">{subtitle}</p>
        )}
        {meta && <p className="text-xs text-gray-400">{meta}</p>}
      </div>
      {timestamp && (
        <span className="shrink-0 text-xs text-gray-400">
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
        className="block hover:bg-gray-50 transition-colors duration-150 rounded-lg -mx-2 px-2"
      >
        <Inner {...props} />
      </a>
    );
  }
  return <Inner {...props} />;
}
