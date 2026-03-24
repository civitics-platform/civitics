"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function DashboardAutoRefresh({ intervalMs = 900_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [secondsAgo, setSecondsAgo] = useState(0);

  useEffect(() => {
    // Count up seconds since last refresh
    const counter = setInterval(() => setSecondsAgo((s) => s + 1), 1000);

    let refresher: ReturnType<typeof setInterval>;

    const start = () => {
      refresher = setInterval(() => {
        router.refresh();
        setSecondsAgo(0);
      }, intervalMs);
    };
    const stop = () => clearInterval(refresher);

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        router.refresh();
        setSecondsAgo(0);
        start();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      stop();
      clearInterval(counter);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, intervalMs]);

  return (
    <span className="text-xs text-gray-400">
      {secondsAgo === 0
        ? "just now"
        : secondsAgo < 60
        ? `${secondsAgo}s ago`
        : `${Math.floor(secondsAgo / 60)}m ago`}
      {" · "}auto-refreshes every {Math.round(intervalMs / 1000)}s
    </span>
  );
}
