// FIX-1306 — one site origin for metadataBase, the sitemap and every entity
// page's <link rel="canonical">.
//
// Before this, the root layout and sitemap.ts each defaulted to the APEX
// (https://civitics.com), which Vercel 307s to www, and no page declared a
// canonical — so the vercel.app alias was indexed as an un-canonicalised
// mirror (cc-230). The canonical host is www.civitics.com (the 10-13 decision,
// and middleware's CANONICAL_ORIGIN for the alias 308).
//
// NEXT_PUBLIC_SITE_URL still wins when set. Production sets it (cc-260 read
// `vercel env ls`: present, value hidden), so this default only decides where
// it is unset — preview, local, CI. The canonical names whatever host it says.
//
// The path is the page's RESOLVED identity — the id of the row the page loaded,
// not the request param. Postgres matches a uuid in any case, so
// /officials/<UPPER-CASE-UUID> renders; its canonical must still name the one
// lower-case URL. (Retired official ids and institution slugs 308 in
// middleware before a page renders — FIX-1278, FIX-1283.)

import type { Metadata } from "next";

export const DEFAULT_SITE_ORIGIN = "https://www.civitics.com";

/** The configured origin with no trailing slash; blank or unset → www. */
export function siteOrigin(configured: string | undefined): string {
  const raw = configured?.trim() ?? "";
  return (raw === "" ? DEFAULT_SITE_ORIGIN : raw).replace(/\/+$/, "");
}

// Dot access, not bracket: Next inlines `process.env.NEXT_PUBLIC_*` by that
// exact shape.
export const SITE_ORIGIN = siteOrigin(process.env.NEXT_PUBLIC_SITE_URL);

/** A canonical path: one leading slash, no query or fragment, no trailing slash (except "/"). */
export function isCanonicalPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (/[?#\s]/.test(path)) return false;
  return path === "/" || !path.endsWith("/");
}

/**
 * `{ alternates: { canonical } }` to spread into a page's metadata. An invalid
 * path yields `{}`: no canonical beats a wrong one, and SEO metadata must never
 * fail a render.
 */
export function canonicalFor(path: string, origin: string = SITE_ORIGIN): Pick<Metadata, "alternates"> {
  if (!isCanonicalPath(path)) return {};
  return { alternates: { canonical: `${origin}${path}` } };
}

/**
 * The entity detail routes. `agency` canonicalises to /institutions/<id>:
 * /agencies/<uuid> never renders (middleware 308s it, FIX-418), so the
 * institution page is the one place that id lives.
 */
export const ENTITY_ROUTE = {
  official: "officials",
  jurisdiction: "jurisdictions",
  district: "districts",
  proposal: "proposals",
  institution: "institutions",
  agency: "institutions",
  meeting: "meetings",
  donor: "donors",
  initiative: "initiatives",
  investigation: "investigations",
} as const;

export type EntityKind = keyof typeof ENTITY_ROUTE;

export function entityPath(kind: EntityKind, id: string): string {
  return `/${ENTITY_ROUTE[kind]}/${encodeURIComponent(id)}`;
}

/** The canonical for an entity page, from the id the page resolved. */
export function canonicalForEntity(
  kind: EntityKind,
  id: string,
  origin: string = SITE_ORIGIN,
): Pick<Metadata, "alternates"> {
  return canonicalFor(entityPath(kind, id), origin);
}
