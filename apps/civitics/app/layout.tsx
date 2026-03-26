import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Civitics",
    template: "%s | Civitics",
  },
  description:
    "Wikipedia meets Bloomberg Terminal for democracy. Structured civic data, legislative tracking, and AI-powered accountability tools.",
  keywords: ["civic", "government", "democracy", "legislation", "accountability"],
  openGraph: {
    type: "website",
    siteName: "Civitics",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
        {process.env.NODE_ENV === "development" && (
          <div
            suppressHydrationWarning
            className="fixed bottom-2 right-2 z-50 bg-black/70 text-white text-xs px-2 py-1 rounded font-mono pointer-events-none"
          >
            local · {new Date().toLocaleTimeString()}
          </div>
        )}
      </body>
    </html>
  );
}
