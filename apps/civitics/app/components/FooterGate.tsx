"use client";

import { usePathname } from "next/navigation";

/**
 * FIX-846 — thin client gate that suppresses the footer on /graph, which owns
 * the full viewport (like NavBar's own usePathname suppression). The Footer is
 * passed as `children` from the server layout, so it stays a Server Component —
 * this wrapper only decides whether to render it. Footer is untouched
 * elsewhere.
 */
export function FooterGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith("/graph")) return null;
  return <>{children}</>;
}
