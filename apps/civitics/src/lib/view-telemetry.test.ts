// cc-273 — the beacon routes' visitor rules (src/lib/view-telemetry.ts): the
// Chrome 133–142 fleet (FIX-1404) and the visitor's country (FIX-1405).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHROME_FLEET_BOT_NAME,
  CHROME_FLEET_UAS,
  isChromeFleetUa,
  visitorCountry,
} from "./view-telemetry";

const win = (v: number) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;

const h = (init: Record<string, string>) => new Headers(init);

describe("isChromeFleetUa", () => {
  it("matches each of the ten strings, and the set holds exactly those ten", () => {
    assert.equal(CHROME_FLEET_UAS.size, 10);
    for (let v = 133; v <= 142; v++) assert.equal(isChromeFleetUa(win(v)), true, `Chrome/${v}`);
  });

  it("does not match the neighbouring and current releases", () => {
    for (const v of [132, 143, 155]) assert.equal(isChromeFleetUa(win(v)), false, `Chrome/${v}`);
  });

  it("does not match Edge, or any UA with a trailing token", () => {
    assert.equal(isChromeFleetUa(`${win(142)} Edg/142.0.0.0`), false);
    assert.equal(isChromeFleetUa(`${win(142)} OPR/127.0.0.0`), false);
  });

  it("does not match the same release on macOS, Linux or Android", () => {
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    const linux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    const android =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
    for (const ua of [mac, linux, android]) assert.equal(isChromeFleetUa(ua), false, ua);
  });

  it("is false for null, undefined and the empty string", () => {
    assert.equal(isChromeFleetUa(null), false);
    assert.equal(isChromeFleetUa(undefined), false);
    assert.equal(isChromeFleetUa(""), false);
  });

  it("ignores surrounding whitespace", () => {
    assert.equal(isChromeFleetUa(`  ${win(137)}\t`), true);
  });

  it("names the bot `chrome-133-142`, the label get_pv_bots groups by", () => {
    assert.equal(CHROME_FLEET_BOT_NAME, "chrome-133-142");
  });
});

describe("visitorCountry", () => {
  it("a valid cf-ipcountry wins over x-vercel-ip-country", () => {
    assert.equal(visitorCountry(h({ "cf-ipcountry": "BR", "x-vercel-ip-country": "US" })), "BR");
  });

  it("upper-cases a lower-case cf-ipcountry", () => {
    assert.equal(visitorCountry(h({ "cf-ipcountry": "vn", "x-vercel-ip-country": "SG" })), "VN");
  });

  it("cf-ipcountry present but unusable → null, never the edge's x-vercel-ip-country", () => {
    for (const cf of ["XX", "T1", "BRA", ""]) {
      assert.equal(visitorCountry(h({ "cf-ipcountry": cf, "x-vercel-ip-country": "US" })), null, `cf=${cf}`);
    }
  });

  it("cf-ipcountry absent → x-vercel-ip-country, as before", () => {
    assert.equal(visitorCountry(h({ "x-vercel-ip-country": "US" })), "US");
  });

  it("both absent → null", () => {
    assert.equal(visitorCountry(h({})), null);
  });
});
