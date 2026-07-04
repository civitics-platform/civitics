import * as React from "react";

interface LoadingSkeletonProps {
  variant: "stat-card" | "pipeline-row" | "activity-item" | "text-line" | "card";
  count?: number;
}

function SkeletonStatCard() {
  return (
    <div className="animate-pulse bg-card rounded-xl border border-rule shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="h-3 w-20 bg-rule/60 rounded-full" />
        <div className="h-5 w-14 bg-rule/60 rounded-full" />
      </div>
      <div className="h-8 w-24 bg-rule/60 rounded mb-2" />
      <div className="h-3 w-32 bg-rule/60 rounded-full" />
    </div>
  );
}

function SkeletonPipelineRow() {
  return (
    <div className="animate-pulse flex items-center gap-3 py-3 px-4">
      <div className="h-4 w-4 bg-rule/60 rounded" />
      <div className="h-4 w-36 bg-rule/60 rounded-full flex-1" />
      <div className="h-5 w-20 bg-rule/60 rounded-full" />
      <div className="h-4 w-24 bg-rule/60 rounded-full" />
      <div className="h-4 w-16 bg-rule/60 rounded-full" />
    </div>
  );
}

function SkeletonActivityItem() {
  return (
    <div className="animate-pulse flex items-start gap-3 py-3">
      <div className="h-8 w-8 bg-rule/60 rounded-full shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="h-4 w-48 bg-rule/60 rounded-full mb-1.5" />
        <div className="h-3 w-24 bg-rule/60 rounded-full" />
      </div>
      <div className="h-3 w-16 bg-rule/60 rounded-full shrink-0" />
    </div>
  );
}

function SkeletonTextLine() {
  return (
    <div className="animate-pulse h-4 w-full bg-rule/60 rounded-full" />
  );
}

function SkeletonCard() {
  return (
    <div className="animate-pulse bg-card rounded-xl border border-rule shadow-sm overflow-hidden">
      <div className="p-4 border-b border-rule/60">
        <div className="h-5 w-40 bg-rule/60 rounded-full mb-2" />
        <div className="h-3 w-64 bg-rule/60 rounded-full" />
      </div>
      <div className="p-4 space-y-3">
        <div className="h-4 w-full bg-rule/60 rounded-full" />
        <div className="h-4 w-5/6 bg-rule/60 rounded-full" />
        <div className="h-4 w-4/6 bg-rule/60 rounded-full" />
      </div>
    </div>
  );
}

const variantMap = {
  "stat-card": SkeletonStatCard,
  "pipeline-row": SkeletonPipelineRow,
  "activity-item": SkeletonActivityItem,
  "text-line": SkeletonTextLine,
  card: SkeletonCard,
};

export function LoadingSkeleton({ variant, count = 1 }: LoadingSkeletonProps) {
  const Component = variantMap[variant];
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Component key={i} />
      ))}
    </>
  );
}
