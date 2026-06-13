import * as React from "react";
import { cn } from "../../lib/cn";

interface SectionCardProps {
  children: React.ReactNode;
  className?: string;
  noPadding?: boolean;
}

export function SectionCard({ children, className, noPadding }: SectionCardProps) {
  return (
    <div
      className={cn(
        "bg-card border border-rule overflow-hidden",
        !noPadding && "p-6",
        className
      )}
    >
      {children}
    </div>
  );
}
