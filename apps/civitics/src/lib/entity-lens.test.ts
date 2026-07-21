// FIX-658/657 — the entity-lens adoption/override/persist ordering is the whole
// point of the shared store, so it is pinned here as a pure unit. Rules under test
// (decisions 3, 4, 8, 9 of the constituent-lens family):
//   - a stored preference beats the async auto-default (and is honored even empty)
//   - a manual toggle beats the auto-default, whenever it lands
//   - the first passing viewer-match probe adopts "constituents"
//   - a disabled (lensEnabled=false) surface is inert: it sees the frozen default

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LENS_STATE,
  LENS_PREF_KEY,
  __resetLensStore,
  dispatchLens,
  getLensState,
  lensKey,
  reduceLens,
  readStoredLensPref,
  subscribeLens,
  writeStoredLensPref,
  type LensState,
} from "./entity-lens";

// A minimal localStorage stand-in — node has no window/localStorage.
function installFakeStorage(seed: Record<string, string> = {}): void {
  const map = new Map(Object.entries(seed));
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  };
}
function clearFakeWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

beforeEach(() => {
  __resetLensStore();
  clearFakeWindow();
});
afterEach(() => {
  __resetLensStore();
  clearFakeWindow();
});

describe("reduceLens ordering", () => {
  it("adopts constituents on the first passing auto-default from the default", () => {
    const next = reduceLens(DEFAULT_LENS_STATE, { type: "auto-default", lens: "constituents" });
    assert.deepEqual(next, { lens: "constituents", overridden: false });
  });

  it("a manual toggle beats a LATER auto-default", () => {
    const manual = reduceLens(DEFAULT_LENS_STATE, { type: "manual", lens: "all" });
    assert.deepEqual(manual, { lens: "all", overridden: true });
    const afterAuto = reduceLens(manual, { type: "auto-default", lens: "constituents" });
    assert.equal(afterAuto, manual, "auto-default must be a no-op once overridden");
  });

  it("a manual toggle beats a PRIOR auto-default", () => {
    const auto = reduceLens(DEFAULT_LENS_STATE, { type: "auto-default", lens: "constituents" });
    assert.deepEqual(auto, { lens: "constituents", overridden: false });
    const manual = reduceLens(auto, { type: "manual", lens: "all" });
    assert.deepEqual(manual, { lens: "all", overridden: true });
    const blocked = reduceLens(manual, { type: "auto-default", lens: "constituents" });
    assert.equal(blocked, manual);
  });

  it("a stored preference beats the auto-default and is honored even for an empty view", () => {
    // Stored "constituents" locks the lens; a later auto-default (or its absence)
    // cannot move it, so an empty constituent view still shows with the toggle.
    const seeded = reduceLens(DEFAULT_LENS_STATE, { type: "stored-pref", lens: "constituents" });
    assert.deepEqual(seeded, { lens: "constituents", overridden: true });
    const stillLocked = reduceLens(seeded, { type: "auto-default", lens: "all" });
    assert.equal(stillLocked, seeded);

    // Stored "Everyone" is equally deliberate — it blocks auto-adoption too.
    const seededAll = reduceLens(DEFAULT_LENS_STATE, { type: "stored-pref", lens: "all" });
    assert.deepEqual(seededAll, { lens: "all", overridden: true });
    const blocked = reduceLens(seededAll, { type: "auto-default", lens: "constituents" });
    assert.equal(blocked, seededAll);
  });

  it("is reference-stable on no-op events (useSyncExternalStore safety)", () => {
    const auto = reduceLens(DEFAULT_LENS_STATE, { type: "auto-default", lens: "constituents" });
    assert.equal(reduceLens(auto, { type: "auto-default", lens: "constituents" }), auto);
    const manual = reduceLens(DEFAULT_LENS_STATE, { type: "manual", lens: "all" });
    assert.equal(reduceLens(manual, { type: "manual", lens: "all" }), manual);
  });
});

describe("module store", () => {
  const KEY = lensKey("official", "11111111-1111-4111-8111-111111111111");

  it("a fresh entry with no stored pref is the default (all, not overridden)", () => {
    assert.deepEqual(getLensState(KEY), { lens: "all", overridden: false });
  });

  it("seeds a new entry from the stored preference at creation time", () => {
    installFakeStorage({ [LENS_PREF_KEY]: "constituents" });
    __resetLensStore(); // force re-seed now that the pref is present
    assert.deepEqual(getLensState(KEY), { lens: "constituents", overridden: true });
  });

  it("notifies subscribers only on a real change", () => {
    let hits = 0;
    const unsub = subscribeLens(KEY, () => void hits++);
    dispatchLens(KEY, { type: "auto-default", lens: "constituents" });
    assert.equal(hits, 1);
    assert.equal(getLensState(KEY).lens, "constituents");
    // Same event again → no state change → no notification.
    dispatchLens(KEY, { type: "auto-default", lens: "constituents" });
    assert.equal(hits, 1);
    unsub();
    dispatchLens(KEY, { type: "manual", lens: "all" });
    assert.equal(hits, 1, "an unsubscribed listener is not called");
  });

  it("first auto-default winner adopts; a manual override then blocks the rest", () => {
    dispatchLens(KEY, { type: "auto-default", lens: "constituents" });
    assert.deepEqual(getLensState(KEY), { lens: "constituents", overridden: false });
    dispatchLens(KEY, { type: "manual", lens: "all" });
    assert.deepEqual(getLensState(KEY), { lens: "all", overridden: true });
    dispatchLens(KEY, { type: "auto-default", lens: "constituents" });
    assert.deepEqual(getLensState(KEY), { lens: "all", overridden: true });
  });
});

describe("localStorage preference (FIX-657)", () => {
  it("reads null under SSR (no window)", () => {
    assert.equal(readStoredLensPref(), null);
  });

  it("write is a silent no-op under SSR", () => {
    assert.doesNotThrow(() => writeStoredLensPref("constituents"));
  });

  it("round-trips a written preference", () => {
    installFakeStorage();
    writeStoredLensPref("constituents");
    assert.equal(readStoredLensPref(), "constituents");
    writeStoredLensPref("all");
    assert.equal(readStoredLensPref(), "all");
  });

  it("ignores a garbage stored value", () => {
    installFakeStorage({ [LENS_PREF_KEY]: "everyone" });
    assert.equal(readStoredLensPref(), null);
  });
});

describe("inert surface (lensEnabled=false)", () => {
  it("the disabled snapshot is the frozen default: all, not overridden", () => {
    // useEntityLens(enabled=false) returns DEFAULT_LENS_STATE verbatim and never
    // touches the store — so the constant itself is the contract.
    const state: LensState = DEFAULT_LENS_STATE;
    assert.deepEqual(state, { lens: "all", overridden: false });
    assert.ok(Object.isFrozen(DEFAULT_LENS_STATE));
  });
});
