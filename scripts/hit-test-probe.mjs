#!/usr/bin/env node
// hit-test-probe.mjs — FIX-1098.
//
// WHAT IT CATCHES: the stretched-link regression class (FIX-1086). A card
// whose title LOOKS clickable but isn't, because an absolutely-positioned
// overlay (or a sibling with a higher stacking order) sits above the title
// text and swallows the click. Nothing else in CI can see this: typecheck,
// lint and unit tests all pass on a card that is unclickable, because the
// defect exists only in composited layout. The only honest test is to ask the
// browser what is actually at the pixel a human aims at.
//
// HOW: launch headless Chrome, drive it over raw CDP (no puppeteer, no deps),
// and for each card title call document.elementFromPoint() at the title's
// centre, then assert elementFromPoint(...).closest("a") resolves to an
// anchor with a real href. That is the same question a click asks.
//
// Dependency-free by design — it runs in a CI job that must not add a
// ~300MB browser-automation dep tree to the repo. Chrome comes from the
// runner image (ubuntu-latest ships one) or from CHROME_PATH.
//
//   node scripts/hit-test-probe.mjs --base http://localhost:3000
//   node scripts/hit-test-probe.mjs --base http://localhost:3000 --route /proposals
//   node scripts/hit-test-probe.mjs --json          # machine-readable summary
//
// EXIT CODES: 0 = every probed title resolved to an anchor (or a route was
// legitimately skipped); 1 = at least one title failed the hit test; 2 = the
// probe itself could not run (no Chrome, server unreachable). CI treats this
// as NON-BLOCKING today — see .github/workflows/hit-test.yml.
//
// NOTE (cache): Network.setCacheDisabled is always sent before navigating. A
// warm HTTP cache has produced false greens in this repo's browser smokes
// before.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let base = "http://localhost:3000";
let asJson = false;
let navTimeoutMs = 45_000;
const routeOverrides = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--base") base = argv[++i];
  else if (a === "--route") routeOverrides.push(argv[++i]);
  else if (a === "--timeout") navTimeoutMs = Number(argv[++i]) * 1000;
  else if (a === "--json") asJson = true;
  else if (a === "--help" || a === "-h") {
    console.log("Usage: node scripts/hit-test-probe.mjs [--base <url>] [--route <path>]... [--timeout <sec>] [--json]");
    process.exit(0);
  }
}
base = base.replace(/\/+$/, "");

// Defensive, mirroring scripts/http-smoke.mjs: Git Bash (MSYS) rewrites a
// leading-"/" argument to the Git install root — `--route /proposals` arrives
// as "C:/Program Files/Git/proposals" and CDP then rejects the navigation with
// "Cannot navigate to invalid URL". Recover the intended path.
function normalizeRoute(t) {
  const p = String(t).replace(/^[A-Za-z]:[\\/](?:.*[\\/])?Git[\\/]?/i, "/");
  if (p === "" || p === "." || p === "/") return "/";
  return p.startsWith("/") ? p : `/${p}`;
}

// ── routes under probe ───────────────────────────────────────────────────────
//
// /proposals and /investigations are the two card-grid routes FIX-1086 actually
// broke, and both render their card shells without any secret: an empty or
// degraded DB yields zero cards, which this probe reports as "no cards" rather
// than failing. /dashboard is probed for its card titles too, but it is the
// route most likely to render data-less in CI (its sections need Supabase), so
// a card-less result there is explicitly not a failure.
const DEFAULT_ROUTES = ["/proposals", "/investigations", "/dashboard"];
const routes = (routeOverrides.length ? routeOverrides : DEFAULT_ROUTES).map(normalizeRoute);

// ── the in-page probe ────────────────────────────────────────────────────────
//
// Target selection is STRUCTURAL, not tag-based. The first cut of this probe
// looked for `article h2, li h3, …` and reported "nothing to probe" on
// /proposals — whose cards are plain `div.group.relative`. It would have sat
// green through the very regression it exists to catch. Card markup differs
// per surface and will keep drifting, so the probe keys on the PATTERN that
// causes the bug instead:
//
//   a stretched link — an absolutely-positioned <a href> that covers its
//   container — with the card's title text underneath it.
//
// That is precisely the FIX-1086 shape. Anything matching it is at risk by
// construction, and anything not matching it cannot exhibit this defect. So
// the probe finds every stretched-link card, locates the title inside, scrolls
// it into view, and asks document.elementFromPoint() what actually occupies
// the title's centre pixel — the same question a click asks. It passes only if
// that resolves to an <a href>.
const MAX_CARDS_PER_ROUTE = 12;
const PROBE_FN = `(() => {
  const cards = [];
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const cs = getComputedStyle(a);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
    const card = a.parentElement;
    if (!card) continue;
    const ar = a.getBoundingClientRect(), pr = card.getBoundingClientRect();
    if (pr.width < 40 || pr.height < 40) continue;
    // "Stretched" = the anchor blankets its container.
    if ((ar.width * ar.height) / (pr.width * pr.height) < 0.8) continue;
    cards.push(card);
  }

  const results = [];
  const total = cards.length;
  let noTitle = 0, offscreen = 0;
  for (const card of cards.slice(0, ${MAX_CARDS_PER_ROUTE})) {
    const title = card.querySelector('[data-hit-test="card-title"], h1, h2, h3, h4');
    if (!title) { noTitle++; continue; }
    // elementFromPoint is viewport-relative, so bring the title into view
    // rather than skipping every card below the fold.
    title.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = title.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) { offscreen++; continue; }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) { offscreen++; continue; }
    const hit = document.elementFromPoint(cx, cy);
    const anchor = hit && hit.closest ? hit.closest('a[href]') : null;
    results.push({
      text: (title.textContent || '').trim().slice(0, 70),
      ok: !!anchor,
      // Name the culprit so a failure is actionable without a repro.
      blockedBy: anchor ? null : (hit ? (hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')) : 'nothing'),
      href: anchor ? anchor.getAttribute('href') : null,
    });
  }
  return JSON.stringify({ total: total, noTitle: noTitle, offscreen: offscreen, probed: results });
})()`;

// ── minimal CDP client ───────────────────────────────────────────────────────
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

function launchChrome(binary) {
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      "--window-size=1280,2400", // tall: more cards land inside the viewport
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not report a DevTools endpoint within 20s")), 20_000);
    child.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(timer); resolve({ child, wsUrl: m[0] }); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (code ${code})`)); });
  });
}

/** Tiny promise-based CDP session over the global WebSocket (Node 22+/24). */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      (events.get(msg.method) ?? []).forEach((fn) => fn(msg.params));
    }
  });
  return {
    ready: new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error(`Cannot open CDP socket ${wsUrl}`)), { once: true });
    }),
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    on(method, fn) {
      if (!events.has(method)) events.set(method, []);
      events.get(method).push(fn);
    },
    close() { try { ws.close(); } catch { /* already gone */ } },
  };
}

function fail(msg) {
  console.error(`[hit-test] ${msg}`);
  process.exit(2);
}

// ── main ─────────────────────────────────────────────────────────────────────
if (typeof globalThis.WebSocket !== "function") {
  fail("No global WebSocket — this probe needs Node 22+ (CI pins 22; see .github/workflows/hit-test.yml).");
}

const chromeBin = findChrome();
if (!chromeBin) fail("No Chrome/Chromium found. Set CHROME_PATH to a browser binary.");

let launched;
try {
  launched = await launchChrome(chromeBin);
} catch (e) {
  fail(`Could not launch Chrome: ${e.message}`);
}
const { child, wsUrl } = launched;
const cdp = connect(wsUrl);

const summary = [];
let failures = 0;

try {
  await cdp.ready;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  // Never let a warm cache produce a false green.
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);

  for (const route of routes) {
    const url = `${base}${route}`;
    const loaded = new Promise((resolve) => {
      const t = setTimeout(() => resolve("timeout"), navTimeoutMs);
      cdp.on("Page.loadEventFired", () => { clearTimeout(t); resolve("load"); });
    });

    let status = null;
    cdp.on("Network.responseReceived", (p) => {
      if (p.type === "Document" && status === null) status = p.response.status;
    });

    await cdp.send("Page.navigate", { url }, sessionId);
    const how = await loaded;
    if (how === "timeout") {
      console.error(`[hit-test] ${route} — navigation timed out after ${navTimeoutMs / 1000}s`);
      summary.push({ route, error: "nav-timeout" });
      failures++;
      continue;
    }
    if (status && status >= 400) {
      console.error(`[hit-test] ${route} — HTTP ${status}, skipping (server-side problem, not a hit-test finding)`);
      summary.push({ route, error: `http-${status}` });
      continue;
    }

    // Let client islands paint; card grids hydrate before this on a warm server.
    await new Promise((r) => setTimeout(r, 1500));

    const { result, exceptionDetails } = await cdp.send(
      "Runtime.evaluate",
      { expression: PROBE_FN, returnByValue: true, awaitPromise: false },
      sessionId,
    );
    if (exceptionDetails) {
      console.error(`[hit-test] ${route} — probe threw: ${exceptionDetails.text}`);
      summary.push({ route, error: "probe-threw" });
      failures++;
      continue;
    }

    const { total, noTitle, offscreen, probed } = JSON.parse(
      result.value ?? '{"total":0,"noTitle":0,"offscreen":0,"probed":[]}',
    );
    const bad = probed.filter((p) => !p.ok);
    summary.push({ route, stretchedCards: total, probed: probed.length, failed: bad.length });

    if (total === 0) {
      // Not a failure: a data-less CI render legitimately has no cards. Said
      // out loud so a silently empty probe is never mistaken for a pass.
      console.log(`[hit-test] ${route} — no stretched-link cards rendered (nothing to probe; not a failure)`);
      continue;
    }
    if (probed.length === 0) {
      // Cards exist but none exposed a probeable title. NOT a pass — printing
      // "0/0 ✓" here would be the probe lying about its own coverage.
      console.log(
        `[hit-test] ${route} — ${total} stretched-link card(s) found but NONE were probeable ` +
        `(${noTitle} with no heading element, ${offscreen} not measurable); nothing verified on this route`,
      );
      continue;
    }
    // Never let a cap or a skip read as full coverage.
    const skipped = total - probed.length;
    if (skipped > 0) {
      const capped = Math.max(0, total - MAX_CARDS_PER_ROUTE);
      console.log(
        `[hit-test] ${route} — ${total} stretched-link cards found, ${probed.length} probed ` +
        `(${capped} over the per-route cap, ${noTitle} no heading, ${offscreen} not measurable)`,
      );
    }
    if (bad.length === 0) {
      console.log(`[hit-test] ${route} — ${probed.length}/${probed.length} card titles hit their anchor ✓`);
    } else {
      failures += bad.length;
      console.error(`[hit-test] ${route} — ${bad.length}/${probed.length} card titles are NOT clickable at their centre:`);
      for (const b of bad.slice(0, 10)) {
        console.error(`  ✗ "${b.text}" — centre pixel resolves to <${b.blockedBy}>, no enclosing <a href>`);
      }
    }
  }
} catch (e) {
  cdp.close();
  child.kill();
  fail(`probe error: ${e.message}`);
}

cdp.close();
child.kill();

if (asJson) console.log(JSON.stringify({ base, routes: summary, failures }, null, 2));

if (failures > 0) {
  console.error(`\n[hit-test] ${failures} hit-test failure(s). This is the FIX-1086 regression class: a title that looks clickable but isn't.`);
  process.exit(1);
}
console.log("\n[hit-test] all probed card titles resolve to an anchor.");
process.exit(0);
