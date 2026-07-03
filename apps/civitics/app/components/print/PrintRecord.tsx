"use client";

import { useEffect, useState } from "react";
import { StampMark } from "../brand/StampMark";

/**
 * Print-only record furniture (FIX-713).
 *
 * Both components render nothing on screen (`hidden`) and appear only in the
 * `@media print` "filed public document" mode (see globals.css). Kept as a
 * client island so the provenance footer can stamp the *actual* print-time URL
 * and date — the record pages are ISR (revalidate=300), so a server-rendered
 * `new Date()` would print the cache-generation date, not the day it was
 * printed. `window.location.href` also yields the exact page URL, origin
 * included, without threading NEXT_PUBLIC_SITE_URL through every caller.
 */

export function PrintLetterhead() {
  return (
    <div className="hidden print:flex items-center gap-2.5 border-b border-black pb-2 mb-5">
      <StampMark size={22} />
      <div className="flex flex-col leading-none">
        <span className="font-serif text-[13px] font-bold uppercase tracking-[0.16em]">
          Civitics
        </span>
        <span className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.2em]">
          The Public Ledger
        </span>
      </div>
      <span className="ml-auto font-mono text-[8px] uppercase tracking-[0.14em]">
        Public record · Filed document
      </span>
    </div>
  );
}

export function PrintProvenance() {
  const [meta, setMeta] = useState<{ url: string; date: string } | null>(null);

  useEffect(() => {
    setMeta({
      url: window.location.href,
      date: new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    });
  }, []);

  return (
    <div className="hidden print:block border-t border-black mt-8 pt-2 font-mono text-[8.5px] leading-relaxed">
      Printed from Civitics — the public ledger
      {meta && (
        <>
          {" · "}
          {meta.url}
          {" · "}
          {meta.date}
        </>
      )}
    </div>
  );
}
