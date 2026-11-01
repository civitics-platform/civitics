/**
 * FIX-1306 — one site origin, and a canonical on every entity detail page.
 *
 * The pure half: the default host, an env override, path validation, and the
 * canonical each entity kind gets. The source half pins the wiring a unit test
 * cannot render (the pages import next/* and React): each detail page's
 * generateMetadata spreads canonicalForEntity() for its kind from the LOADED
 * row's id, and the root layout and the sitemap read SITE_ORIGIN. The rendered
 * <link rel="canonical"> was read through `next start` for each kind (cc-260).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalFor,
  canonicalForEntity,
  entityPath,
  isCanonicalPath,
  siteOrigin,
  DEFAULT_SITE_ORIGIN,
  ENTITY_ROUTE,
  SITE_ORIGIN,
  type EntityKind,
} from "./canonical";

const APP = join(__dirname, "..", "..", "app");
const read = (rel: string) => readFileSync(join(APP, rel), "utf8");
const ID = "0b4cf8a2-6c1d-4a7e-9f3b-2d5e8a1c7f90";

test("FIX-1306 the default host is www, not the apex Vercel 307s", () => {
  assert.equal(DEFAULT_SITE_ORIGIN, "https://www.civitics.com");
  assert.equal(siteOrigin(undefined), "https://www.civitics.com");
  assert.equal(siteOrigin(""), "https://www.civitics.com");
  assert.equal(siteOrigin("   "), "https://www.civitics.com");
  assert.equal(SITE_ORIGIN, siteOrigin(process.env.NEXT_PUBLIC_SITE_URL), "the module constant reads the env");
});

test("FIX-1306 NEXT_PUBLIC_SITE_URL overrides the default, normalised", () => {
  assert.equal(siteOrigin("https://civitics.com"), "https://civitics.com");
  assert.equal(siteOrigin("https://www.civitics.com/"), "https://www.civitics.com");
  assert.equal(siteOrigin(" http://localhost:3000// "), "http://localhost:3000");
});

test("FIX-1306 the path is validated: one leading slash, no query, no fragment, no trailing slash", () => {
  for (const ok of ["/", "/officials/abc", "/proposals"]) assert.ok(isCanonicalPath(ok), ok);
  for (const bad of ["officials/abc", "//evil.com/x", "/officials/abc/", "/proposals?page=2", "/a#b", "/a b", ""]) {
    assert.equal(isCanonicalPath(bad), false, JSON.stringify(bad));
    assert.deepEqual(canonicalFor(bad), {}, `${JSON.stringify(bad)} names no canonical rather than a wrong one`);
  }
  assert.deepEqual(canonicalFor("/proposals", DEFAULT_SITE_ORIGIN), {
    alternates: { canonical: "https://www.civitics.com/proposals" },
  });
});

const KINDS: Array<[EntityKind, string]> = [
  ["official", "officials"],
  ["jurisdiction", "jurisdictions"],
  ["district", "districts"],
  ["proposal", "proposals"],
  ["institution", "institutions"],
  ["agency", "institutions"],
  ["meeting", "meetings"],
  ["donor", "donors"],
  ["initiative", "initiatives"],
  ["investigation", "investigations"],
];

test("FIX-1306 the ten entity kinds — agency canonicalises to its institution page", () => {
  assert.equal(KINDS.length, Object.keys(ENTITY_ROUTE).length);
  for (const [kind, segment] of KINDS) {
    assert.deepEqual(
      canonicalForEntity(kind, ID, DEFAULT_SITE_ORIGIN),
      { alternates: { canonical: `https://www.civitics.com/${segment}/${ID}` } },
      kind,
    );
  }
  assert.equal(entityPath("donor", "a/b"), "/donors/a%2Fb", "an id cannot add a path segment");
});

// Each page, the kind it declares, and the expression its generateMetadata
// takes the id from — the loaded row, never params.
const PAGES: Array<[string, EntityKind, string]> = [
  ["officials/[id]/page.tsx", "official", "data.id"],
  ["jurisdictions/[id]/page.tsx", "jurisdiction", "data.id"],
  ["districts/[id]/page.tsx", "district", "data.id"],
  ["proposals/[id]/page.tsx", "proposal", "data.id"],
  ["institutions/[id]/page.tsx", "institution", "data.id"],
  ["meetings/[id]/page.tsx", "meeting", "m.id"],
  ["donors/[id]/page.tsx", "donor", "entity.id"],
  ["initiatives/[id]/page.tsx", "initiative", "proposal.id"],
  ["investigations/[id]/page.tsx", "investigation", "investigation.id"],
];

for (const [file, kind, idExpr] of PAGES) {
  test(`FIX-1306 ${file} spreads the ${kind} canonical from ${idExpr}`, () => {
    const src = read(file);
    const meta = src.slice(src.indexOf("export async function generateMetadata"));
    assert.ok(meta.length < src.length, "has a generateMetadata");
    const body = meta.slice(0, meta.indexOf("\n}\n"));
    assert.ok(body.includes(`canonicalForEntity("${kind}", ${idExpr})`), `canonicalForEntity("${kind}", ${idExpr})`);
    assert.doesNotMatch(body, /canonical[^\n]*params/, "never from the request param");
  });
}

test("FIX-1306 /agencies/[slug] never renders — it 308s to the institution page", () => {
  const src = read("agencies/[slug]/page.tsx");
  assert.match(src, /permanentRedirect\(`\/institutions\/\$\{data\.id\}`\)/);
});

test("FIX-1306 one host, three consumers: layout and sitemap read SITE_ORIGIN, and no apex default is left", () => {
  const layout = read("layout.tsx");
  const sitemap = read("sitemap.ts");
  assert.match(layout, /metadataBase: new URL\(SITE_ORIGIN\)/);
  assert.match(sitemap, /const BASE = SITE_ORIGIN;/);
  for (const [name, src] of [["layout.tsx", layout], ["sitemap.ts", sitemap]] as const) {
    assert.doesNotMatch(src, /"https:\/\/civitics\.com"/, `${name} has no apex default`);
  }
});
