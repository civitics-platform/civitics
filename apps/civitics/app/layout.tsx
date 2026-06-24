import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { AuthHashHandler } from "./components/AuthHashHandler";
import { ChallengeModal } from "./components/ChallengeModal";
import { Footer } from "./components/Footer";
import { NavBar } from "./components/NavBar";
import { WebVitalsReporter } from "./components/WebVitalsReporter";
import "./globals.css";

// Self-hosted, preloaded fonts. `display: swap` shows fallback text immediately
// (preventing FOIT) and swaps to Inter/JetBrains once they're ready.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

// Display serif for the "Public Record" register — headlines, masthead
// wordmark, ledger names. Variable font; italic carries the brand voice
// ("with receipts.", footer tagline).
const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif",
  style: ["normal", "italic"],
  axes: ["opsz"],
});

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
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} ${fraunces.variable}`}
    >
      <body className="font-sans">
        <NavBar />
        {children}
        <Footer />
        <AuthHashHandler />
        <ChallengeModal />
        <WebVitalsReporter />
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
