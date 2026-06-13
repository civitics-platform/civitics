import * as React from "react";
import { cn } from "../../lib/cn";

interface PageHeaderProps {
  title: string;
  description?: string;
  breadcrumb?: Array<{
    label: string;
    href?: string;
  }>;
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
    variant?: "primary" | "secondary";
  };
  badge?: string;
}

const ACTION_BASE =
  "inline-flex items-center px-4 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1";
const ACTION_PRIMARY = "bg-ink text-paper hover:bg-accent";
const ACTION_SECONDARY = "border border-rule bg-card text-ink hover:border-accent hover:text-accent";

export function PageHeader({
  title,
  description,
  breadcrumb,
  action,
  badge,
}: PageHeaderProps) {
  return (
    <div className="mb-6">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          className="mb-2 flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-soft"
        >
          <ol className="flex items-center gap-1 list-none p-0 m-0">
            {breadcrumb.map((item, i) => (
              <li key={i} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden="true" className="text-ink-soft/50">/</span>}
                {item.href ? (
                  <a
                    href={item.href}
                    className="hover:text-accent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {item.label}
                  </a>
                ) : (
                  <span aria-current="page" className="text-ink font-semibold">{item.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="font-serif text-3xl font-bold text-ink truncate">{title}</h1>
            {badge && (
              <span className="inline-flex items-center border border-civic-blue px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-civic-blue">
                {badge}
              </span>
            )}
          </div>
          {description && (
            <p className="mt-1 text-sm text-ink-soft">{description}</p>
          )}
        </div>
        {action && (
          <div className="shrink-0 mt-0.5">
            {action.href ? (
              <a
                href={action.href}
                className={cn(
                  ACTION_BASE,
                  action.variant === "secondary" ? ACTION_SECONDARY : ACTION_PRIMARY
                )}
              >
                {action.label}
              </a>
            ) : (
              <button
                type="button"
                onClick={action.onClick}
                className={cn(
                  ACTION_BASE,
                  action.variant === "secondary" ? ACTION_SECONDARY : ACTION_PRIMARY
                )}
              >
                {action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
