// cc-270 / cc-272 — the limiter's identifier (src/lib/client-ip.ts), as
// middleware.ts's bucket check and its /api/cron/limiter-health answer call it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cfConnectingIpKey, getClientIp, resolveClientIp } from "./client-ip";

const h = (init: Record<string, string>) => new Headers(init);

describe("getClientIp", () => {
  it("keys on x-forwarded-for's first hop, trimmed", () => {
    assert.equal(getClientIp(h({ "x-forwarded-for": " 203.0.113.7 , 172.70.1.1" })), "203.0.113.7");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    assert.equal(getClientIp(h({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
  });

  it("is `unknown` with neither — one shared bucket", () => {
    assert.equal(getClientIp(h({})), "unknown");
  });
});

describe("resolveClientIp names the header it used (the stamp's key=)", () => {
  it("xff / real / unknown", () => {
    assert.deepEqual(resolveClientIp(h({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4" })), {
      ip: "203.0.113.7",
      source: "xff",
    });
    assert.deepEqual(resolveClientIp(h({ "x-real-ip": "198.51.100.4" })), { ip: "198.51.100.4", source: "real" });
    assert.deepEqual(resolveClientIp(h({})), { ip: "unknown", source: "unknown" });
  });

  it("a cf-connecting-ip alone is not a key source", () => {
    assert.deepEqual(resolveClientIp(h({ "cf-connecting-ip": "203.0.113.7" })), { ip: "unknown", source: "unknown" });
  });
});

// FIX-1401 (cc-272 D5): cf-connecting-ip, only under the flag.
describe("trustCfConnectingIp × the three headers", () => {
  const ALL = { "x-forwarded-for": "172.70.1.1", "x-real-ip": "172.70.1.1", "cf-connecting-ip": "203.0.113.7" };
  const cases: Array<[Record<string, string>, boolean, { ip: string; source: string }]> = [
    [ALL, false, { ip: "172.70.1.1", source: "xff" }],
    [ALL, true, { ip: "203.0.113.7", source: "cf" }],
    [{ "x-forwarded-for": "172.70.1.1" }, true, { ip: "172.70.1.1", source: "xff" }],
    [{ "x-real-ip": "172.70.1.2" }, true, { ip: "172.70.1.2", source: "real" }],
    [{ "x-real-ip": "172.70.1.2", "cf-connecting-ip": "203.0.113.7" }, true, { ip: "203.0.113.7", source: "cf" }],
    [{ "x-real-ip": "172.70.1.2", "cf-connecting-ip": "203.0.113.7" }, false, { ip: "172.70.1.2", source: "real" }],
    [{ "cf-connecting-ip": "203.0.113.7" }, true, { ip: "203.0.113.7", source: "cf" }],
    [{ "cf-connecting-ip": "203.0.113.7" }, false, { ip: "unknown", source: "unknown" }],
    [{}, true, { ip: "unknown", source: "unknown" }],
  ];
  for (const [headers, trust, want] of cases) {
    it(`${JSON.stringify(headers)} trust=${trust} → ${want.source} ${want.ip}`, () => {
      assert.deepEqual(resolveClientIp(h(headers), { trustCfConnectingIp: trust }), want);
      assert.equal(getClientIp(h(headers), { trustCfConnectingIp: trust }), want.ip);
    });
  }

  it("a forged cf-connecting-ip is ignored without the flag (cc-270: Vercel passes it through)", () => {
    const forged = h({ "x-forwarded-for": "198.51.100.9", "cf-connecting-ip": "192.0.2.2" });
    assert.equal(getClientIp(forged), "198.51.100.9");
    assert.equal(getClientIp(forged, {}), "198.51.100.9");
    assert.equal(getClientIp(forged, { trustCfConnectingIp: false }), "198.51.100.9");
  });

  it("an empty or unparseable cf-connecting-ip falls back to the chain", () => {
    for (const bad of ["", "   ", "not-an-ip", "1.2.3", "300.1.1.1", "01.2.3.4", "2001:db8:::1", "1:2:3:4:5:6:7:8:9",
      "fe80::1%eth0", "1.2.3.4::", "gggg::1", ":1:2::", "203.0.113.7, 198.51.100.1"]) {
      assert.deepEqual(
        resolveClientIp(h({ "x-forwarded-for": "172.70.1.1", "cf-connecting-ip": bad }), { trustCfConnectingIp: true }),
        { ip: "172.70.1.1", source: "xff" },
        JSON.stringify(bad),
      );
    }
  });
});

describe("cfConnectingIpKey: IPv4 whole, IPv6 on its /64", () => {
  it("IPv4 is used whole, trimmed", () => {
    assert.equal(cfConnectingIpKey(" 203.0.113.7 "), "203.0.113.7");
    assert.equal(cfConnectingIpKey("0.0.0.0"), "0.0.0.0");
    assert.equal(cfConnectingIpKey("255.255.255.255"), "255.255.255.255");
  });

  it("IPv6 full form → the first four hextets, zero-padded, lower case", () => {
    assert.equal(cfConnectingIpKey("2001:0DB8:85A3:0000:0000:8A2E:0370:7334"), "2001:0db8:85a3:0000::/64");
  });

  it("IPv6 compressed (::) expands before the cut", () => {
    assert.equal(cfConnectingIpKey("2001:db8::1"), "2001:0db8:0000:0000::/64");
    assert.equal(cfConnectingIpKey("2001:db8:a:b::"), "2001:0db8:000a:000b::/64");
    assert.equal(cfConnectingIpKey("2001:db8:a:b:c::d"), "2001:0db8:000a:000b::/64");
    assert.equal(cfConnectingIpKey("::1"), "0000:0000:0000:0000::/64");
    assert.equal(cfConnectingIpKey("::"), "0000:0000:0000:0000::/64");
  });

  it("two addresses in one /64 share a key; the next /64 does not", () => {
    const a = cfConnectingIpKey("2a03:2880:f00c:1::face:b00c");
    assert.equal(a, cfConnectingIpKey("2a03:2880:f00c:1:ffff:ffff:ffff:ffff"));
    assert.notEqual(a, cfConnectingIpKey("2a03:2880:f00c:2::1"));
  });

  it("IPv4-mapped IPv6 is the IPv4 client, whole", () => {
    assert.equal(cfConnectingIpKey("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(cfConnectingIpKey("::FFFF:cb00:7107"), "203.0.113.7");
    assert.equal(cfConnectingIpKey("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7");
  });

  it("a trailing dotted quad that is not IPv4-mapped is still a /64", () => {
    assert.equal(cfConnectingIpKey("64:ff9b::203.0.113.7"), "0064:ff9b:0000:0000::/64");
  });

  it("null, empty and junk are null", () => {
    assert.equal(cfConnectingIpKey(null), null);
    assert.equal(cfConnectingIpKey(""), null);
    assert.equal(cfConnectingIpKey("1.2.3.4.5"), null);
    assert.equal(cfConnectingIpKey("12345::1"), null);
  });
});
