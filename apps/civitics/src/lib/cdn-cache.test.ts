// FIX-796 regression test — withPublicCdnCache stamps both CDN headers with
// the expected policy values and never touches the browser-facing
// Cache-Control (Next's own private/no-store for dynamic routes must stand
// for browsers; only the shared edges get the public s-maxage window).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withPublicCdnCache, CDN_HOT_S_MAXAGE, CDN_HOT_SWR } from "./cdn-cache";

describe("withPublicCdnCache", () => {
  it("stamps both CDN headers with the default hot policy", () => {
    const res = withPublicCdnCache(new Response("{}"));
    const expected = `public, s-maxage=${CDN_HOT_S_MAXAGE}, stale-while-revalidate=${CDN_HOT_SWR}`;
    assert.equal(res.headers.get("CDN-Cache-Control"), expected);
    assert.equal(res.headers.get("Vercel-CDN-Cache-Control"), expected);
  });

  it("accepts per-route overrides (e.g. the dashboard's 1800/3600)", () => {
    const res = withPublicCdnCache(new Response("{}"), 1800, 3600);
    assert.equal(
      res.headers.get("CDN-Cache-Control"),
      "public, s-maxage=1800, stale-while-revalidate=3600",
    );
  });

  it("does not set or modify the browser-facing Cache-Control", () => {
    const res = withPublicCdnCache(new Response("{}"));
    assert.equal(res.headers.get("Cache-Control"), null);
    const preset = new Response("{}", { headers: { "Cache-Control": "no-store" } });
    withPublicCdnCache(preset);
    assert.equal(preset.headers.get("Cache-Control"), "no-store");
  });

  it("returns the same response instance (chainable at the return site)", () => {
    const res = new Response("{}");
    assert.equal(withPublicCdnCache(res), res);
  });
});
