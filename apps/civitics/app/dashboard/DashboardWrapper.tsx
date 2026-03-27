"use client";

import dynamic from "next/dynamic";

const DashboardClient = dynamic(
  () => import("./DashboardClient").then((m) => ({ default: m.DashboardClient })),
  { ssr: false },
);

interface DashboardWrapperProps {
  openProposals: Array<{
    id: string;
    title: string;
    agency: string;
    comment_period_end: string;
  }>;
  activity: Array<{
    path: string;
    views: number;
  }>;
  officialsBreakdown: {
    federal: number;
    state: number;
    judges: number;
  } | null;
}

export function DashboardWrapper(props: DashboardWrapperProps) {
  return <DashboardClient {...props} />;
}
