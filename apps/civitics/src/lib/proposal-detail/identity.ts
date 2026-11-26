/**
 * FIX-1447 (cc-317 D5, D6, D7) — the proposal page's identity line, its
 * metadata title, the latest-action line and the source link, from rows the
 * database already holds (bill_details + proposals). Nothing is fetched or
 * generated here.
 */

export type BillDetails = {
  bill_number: string | null;
  chamber: string | null;
  congress_number: number | null;
  congress_gov_url: string | null;
};

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

/** 119 → "119th", 101 → "101st", 112 → "112th". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** bill_details.chamber is stored lower-case ('house' | 'senate'); Legistar rows say 'council'. */
export function chamberLabel(chamber: string | null | undefined): string | null {
  const c = text(chamber)?.toLowerCase();
  if (c === "house") return "House";
  if (c === "senate") return "Senate";
  return null;
}

/**
 * D5. Federal: "HR 1 · 119th Congress · House". OpenStates: "SB 185 · DE".
 * Legistar: its file number ("CB 119913"). Anything else: null.
 */
export function identityLine(bd: BillDetails | null, metadata: Record<string, unknown> | null): string | null {
  const number = text(bd?.bill_number);
  if (number && bd?.congress_number != null) {
    return [number, `${ordinal(bd.congress_number)} Congress`, chamberLabel(bd.chamber)].filter(Boolean).join(" · ");
  }
  const state = text(metadata?.["state"]);
  if (number && state) return `${number} · ${state}`;
  return text(metadata?.["file_number"]);
}

/** D5. generateMetadata's title: "<number> — <title>" when a number exists and the title is not it. */
export function metadataTitle(title: string, bd: BillDetails | null): string {
  const number = text(bd?.bill_number);
  if (!number) return title;
  const norm = (s: string) => s.replace(/[\s.]/g, "").toUpperCase();
  return norm(title) === norm(number) ? title : `${number} — ${title}`;
}

/**
 * D6. The latest-action line: metadata.latest_action (a string; an object's
 * `text` if a source ever writes one) with proposals.last_action_at. Null
 * when no action text is stored — a date alone says nothing.
 */
export function latestAction(
  metadata: Record<string, unknown> | null,
  lastActionAt: string | null,
): { text: string; date: string | null } | null {
  const raw = metadata?.["latest_action"];
  const t =
    text(raw) ??
    (raw && typeof raw === "object" ? text((raw as Record<string, unknown>)["text"]) : null);
  if (!t) return null;
  let date: string | null = null;
  if (lastActionAt) {
    const d = new Date(lastActionAt);
    if (!Number.isNaN(d.getTime())) {
      date = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    }
  }
  return { text: t, date };
}

/**
 * D7. The source link: bill_details.congress_gov_url, else proposals.external_url.
 * "View on congress.gov ↗" when the host is congress.gov, else "View source ↗".
 * Null when neither is an http(s) URL, or when the URL is already linked in
 * the same row (`alreadyLinked`, e.g. the regulations.gov link).
 */
export function sourceLink(p: {
  congressGovUrl: string | null | undefined;
  externalUrl: string | null | undefined;
  alreadyLinked?: (string | null | undefined)[];
}): { href: string; label: string } | null {
  const href = text(p.congressGovUrl) ?? text(p.externalUrl);
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  if ((p.alreadyLinked ?? []).some((l) => l && same(l, href))) return null;
  const host = url.hostname.toLowerCase();
  const congress = host === "congress.gov" || host.endsWith(".congress.gov");
  return { href, label: congress ? "View on congress.gov ↗" : "View source ↗" };
}
