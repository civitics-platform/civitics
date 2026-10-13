// FIX-1305 unit tests for the origin-auth core (src/lib/origin-auth.ts).
//
// Two decisions, both pure: the alias-host 308 (D0) and the "came through
// Cloudflare" header check (D1–D4). middleware.ts does the header reads, the
// responses and the sampled log; the call ORDER there is pinned by
// origin-auth-middleware.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALIAS_HOST,
  CRON_PATH_PREFIX,
  aliasRedirectTarget,
  constantTimeEqual,
  createSampler,
  decideAliasRedirect,
  decideOriginAuth,
  formatOriginLogLine,
  parseOriginAuthMode,
  type OriginAuthMode,
} from "./origin-auth";

const SECRET = "a".repeat(64);

function decide(over: {
  path?: string;
  headerValue?: string | null;
  secret?: string | undefined;
  mode?: OriginAuthMode;
  vercelEnv?: string | undefined;
}) {
  return decideOriginAuth({
    path: over.path ?? "/officials",
    headerValue: over.headerValue === undefined ? null : over.headerValue,
    secret: "secret" in over ? over.secret : SECRET,
    mode: over.mode ?? "enforce",
    vercelEnv: "vercelEnv" in over ? over.vercelEnv : "production",
  });
}

describe("decideAliasRedirect (D0)", () => {
  it("redirects an alias-host page request", () => {
    assert.deepEqual(decideAliasRedirect({ host: ALIAS_HOST, path: "/officials/x" }), { redirect: true });
  });

  it("does not redirect the alias host's /api/cron/* — Vercel's scheduler may call it there", () => {
    assert.deepEqual(decideAliasRedirect({ host: ALIAS_HOST, path: "/api/cron/box-health" }), { redirect: false });
  });

  it("does not redirect www.civitics.com", () => {
    assert.deepEqual(decideAliasRedirect({ host: "www.civitics.com", path: "/officials/x" }), { redirect: false });
  });

  it("does not redirect a request with no Host", () => {
    assert.deepEqual(decideAliasRedirect({ host: null, path: "/officials/x" }), { redirect: false });
    assert.deepEqual(decideAliasRedirect({ host: undefined, path: "/officials/x" }), { redirect: false });
  });

  it("strips a port before comparing", () => {
    assert.deepEqual(decideAliasRedirect({ host: `${ALIAS_HOST}:443`, path: "/officials/x" }), { redirect: true });
  });

  it("compares the hostname case-insensitively", () => {
    assert.deepEqual(decideAliasRedirect({ host: ALIAS_HOST.toUpperCase(), path: "/" }), { redirect: true });
  });

  it("does not match a host that merely contains the alias", () => {
    assert.deepEqual(decideAliasRedirect({ host: `x${ALIAS_HOST}`, path: "/" }), { redirect: false });
    assert.deepEqual(decideAliasRedirect({ host: `${ALIAS_HOST}.evil.com`, path: "/" }), { redirect: false });
  });
});

describe("aliasRedirectTarget (D0)", () => {
  it("keeps the path and query, on www.civitics.com", () => {
    assert.equal(aliasRedirectTarget("/officials/x", "?a=1").href, "https://www.civitics.com/officials/x?a=1");
    assert.equal(aliasRedirectTarget("/", "").href, "https://www.civitics.com/");
  });

  it("never leaves www.civitics.com — a protocol-relative path is not an open redirect", () => {
    const target = aliasRedirectTarget("//evil.com/x", "");
    assert.equal(target.host, "www.civitics.com");
    assert.equal(target.protocol, "https:");
  });
});

describe("parseOriginAuthMode (D2)", () => {
  it("unset or empty → off", () => {
    assert.deepEqual(parseOriginAuthMode(undefined), { mode: "off", reason: "unset" });
    assert.deepEqual(parseOriginAuthMode(""), { mode: "off", reason: "unset" });
    assert.deepEqual(parseOriginAuthMode("   "), { mode: "off", reason: "unset" });
  });

  it("the three modes, trimmed and case-insensitive", () => {
    assert.deepEqual(parseOriginAuthMode("off"), { mode: "off", reason: "known" });
    assert.deepEqual(parseOriginAuthMode("report"), { mode: "report", reason: "known" });
    assert.deepEqual(parseOriginAuthMode(" Enforce "), { mode: "enforce", reason: "known" });
  });

  it("an unknown string → off, with a reason", () => {
    assert.deepEqual(parseOriginAuthMode("on"), { mode: "off", reason: "unknown" });
    assert.deepEqual(parseOriginAuthMode("true"), { mode: "off", reason: "unknown" });
  });
});

describe("decideOriginAuth (D1–D4)", () => {
  it("off by default", () => {
    assert.deepEqual(decide({ mode: "off" }), { action: "pass", reason: "mode-off" });
  });

  it("off when the secret is unset or empty — never refuse on a missing secret", () => {
    assert.deepEqual(decide({ secret: undefined }), { action: "pass", reason: "no-secret" });
    assert.deepEqual(decide({ secret: "" }), { action: "pass", reason: "no-secret" });
  });

  it("off outside production, even in enforce", () => {
    for (const vercelEnv of ["preview", "development", undefined]) {
      assert.deepEqual(decide({ vercelEnv }), { action: "pass", reason: "not-production" });
    }
  });

  it("/api/cron/* passes in enforce with no header", () => {
    assert.deepEqual(decide({ path: "/api/cron/x" }), { action: "pass", reason: "cron-exempt" });
  });

  it("the exemption is exactly the /api/cron/ prefix", () => {
    assert.equal(CRON_PATH_PREFIX, "/api/cron/");
    assert.deepEqual(decide({ path: "/api/cron" }), { action: "refuse", reason: "missing" });
    assert.deepEqual(decide({ path: "/api/cronx/y" }), { action: "refuse", reason: "missing" });
    assert.deepEqual(decide({ path: "/auth/callback" }), { action: "refuse", reason: "missing" });
  });

  it("a matching header passes", () => {
    assert.deepEqual(decide({ headerValue: SECRET }), { action: "pass", reason: "match" });
    assert.deepEqual(decide({ headerValue: SECRET, mode: "report" }), { action: "pass", reason: "match" });
  });

  it("a wrong header → report in report mode, refuse in enforce", () => {
    const wrong = "b".repeat(64);
    assert.deepEqual(decide({ headerValue: wrong, mode: "report" }), { action: "report", reason: "mismatch" });
    assert.deepEqual(decide({ headerValue: wrong, mode: "enforce" }), { action: "refuse", reason: "mismatch" });
  });

  it("no header → report in report mode, refuse in enforce", () => {
    assert.deepEqual(decide({ mode: "report" }), { action: "report", reason: "missing" });
    assert.deepEqual(decide({ mode: "enforce" }), { action: "refuse", reason: "missing" });
  });

  it("a header of a different length → refuse", () => {
    assert.deepEqual(decide({ headerValue: SECRET.slice(1) }), { action: "refuse", reason: "mismatch" });
    assert.deepEqual(decide({ headerValue: `${SECRET}a` }), { action: "refuse", reason: "mismatch" });
    assert.deepEqual(decide({ headerValue: "" }), { action: "refuse", reason: "mismatch" });
  });
});

describe("constantTimeEqual (D1)", () => {
  it("equal strings", () => {
    assert.equal(constantTimeEqual(SECRET, SECRET), true);
    assert.equal(constantTimeEqual("", ""), true);
  });

  it("one differing character anywhere", () => {
    assert.equal(constantTimeEqual(`b${SECRET.slice(1)}`, SECRET), false);
    assert.equal(constantTimeEqual(`${SECRET.slice(0, -1)}b`, SECRET), false);
  });

  it("a prefix or an extension of the secret is not equal", () => {
    assert.equal(constantTimeEqual(SECRET.slice(0, 32), SECRET), false);
    assert.equal(constantTimeEqual(`${SECRET}\u0000`, SECRET), false);
    assert.equal(constantTimeEqual("", SECRET), false);
  });
});

describe("createSampler (D6)", () => {
  it("first event, then every Nth", () => {
    const sample = createSampler(100);
    const hits: number[] = [];
    for (let i = 1; i <= 250; i++) if (sample()) hits.push(i);
    assert.deepEqual(hits, [1, 100, 200]);
  });
});

describe("formatOriginLogLine (D6)", () => {
  it("names host, path, method, cf-ray presence and the first 60 UA chars", () => {
    const ua = "x".repeat(80);
    assert.equal(
      formatOriginLogLine({ verb: "miss", host: ALIAS_HOST, path: "/officials", method: "GET", cfRay: false, ua }),
      `[origin-auth] miss host=${ALIAS_HOST} path=/officials method=GET cf-ray=no ua=${"x".repeat(60)}`,
    );
  });

  it("cf-ray=yes, refused, and a missing host/UA", () => {
    assert.equal(
      formatOriginLogLine({ verb: "refused", host: null, path: "/", method: "POST", cfRay: true, ua: null }),
      "[origin-auth] refused host=- path=/ method=POST cf-ray=yes ua=-",
    );
  });
});
