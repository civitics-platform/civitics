import * as React from "react";

interface TabBarProps {
  tabs: Array<{
    id: string;
    label: string;
    count?: number;
    href?: string;
  }>;
  activeTab: string;
  onTabChange?: (id: string) => void;
}

export function TabBar({ tabs, activeTab, onTabChange }: TabBarProps) {
  return (
    <div className="flex items-center gap-0 border-b border-rule overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;

        const inner = (
          <>
            <span>{tab.label}</span>
            {typeof tab.count === "number" && (
              <span className="ml-1.5 inline-flex items-center rounded-full bg-ink/5 px-2 py-0.5 text-xs font-medium text-ink-soft">
                {tab.count.toLocaleString()}
              </span>
            )}
          </>
        );

        const baseClass =
          "inline-flex items-center gap-1 px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors duration-150";
        const activeClass =
          "border-accent text-accent";
        const inactiveClass =
          "border-transparent text-ink-soft hover:text-ink hover:border-rule";

        if (tab.href) {
          return (
            <a
              key={tab.id}
              href={tab.href}
              className={`${baseClass} ${isActive ? activeClass : inactiveClass}`}
              aria-current={isActive ? "page" : undefined}
            >
              {inner}
            </a>
          );
        }

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange?.(tab.id)}
            className={`${baseClass} ${isActive ? activeClass : inactiveClass}`}
            aria-current={isActive ? "page" : undefined}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}
