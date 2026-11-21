/**
 * FIX-1435 — /graph's mount handoffs compose.
 *
 * GraphPage's entity handoff (`addEntity` per id) and its preset handoff
 * (`applyPreset`, then `addGroup` for the preset's seed group) run in the same
 * mount commit, so their `setView` calls queue against one render's `view`.
 * `applyPreset` passed a VALUE computed from that render's view, which has no
 * entities yet, and the value replaced the queued `addEntity` result:
 * `/graph?addEntityIds=…&preset=full-record` loaded with an empty focus. It
 * now passes an updater.
 *
 * The hook is mounted for real through react-dom/server. A setState during
 * render is a render-phase update, and React replays it through the same
 * reducer a client commit uses: a function receives the latest queued state,
 * a value replaces it. packages/graph's own *.test.ts files have no runner in
 * CI, so this lives in the app suite and loads the hook by relative path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useGraphView } from "../../../../packages/graph/src/hooks/useGraphView";
import { BUILT_IN_PRESETS } from "../../../../packages/graph/src/presets";
import { getGroupById } from "../../../../packages/graph/src/groups";
import type { GraphView, GraphViewPreset } from "../../../../packages/graph/src/types";

const HOOK_SRC = readFileSync(
  join(__dirname, "..", "..", "..", "..", "packages", "graph", "src", "hooks", "useGraphView.ts"),
  "utf8",
);

type GraphHooks = ReturnType<typeof useGraphView>;

/** Mount useGraphView, call `run` once during the first render, return the settled view. */
function mountAndRun(run: (hooks: GraphHooks) => void): GraphView {
  let settled: GraphView | undefined;
  function Probe() {
    const hooks = useGraphView();
    const ran = useRef(false);
    if (!ran.current) {
      ran.current = true;
      run(hooks);
    }
    settled = hooks.view;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.ok(settled, "the probe rendered");
  return settled;
}

function preset(id: string): GraphViewPreset {
  const p = BUILT_IN_PRESETS.find((x) => x.meta.presetId === id);
  assert.ok(p, `built-in preset ${id} exists`);
  return p;
}

// Roger Marshall — the official in the FIX-1435 owed look.
const OFFICIAL = { id: "60f87348-1ffc-427f-b80c-5f416967cd41", name: "60f87348-1ffc-427f-b80c-5f416967cd41", type: "official" as const };

test("FIX-1435: addEntity then applyPreset in one commit keeps the entity", () => {
  const view = mountAndRun((g) => {
    g.addEntity(OFFICIAL);
    g.applyPreset(preset("full-record"));
  });
  assert.deepEqual(view.focus.entities.map((e) => e.id), [OFFICIAL.id]);
  assert.equal(view.meta?.presetId, "full-record");
});

test("FIX-1435: entity handoff, applyPreset, then the seed addGroup keeps all three", () => {
  const group = getGroupById("group-full-senate");
  assert.ok(group, "follow-the-money's seed group exists");
  const view = mountAndRun((g) => {
    g.addEntity(OFFICIAL);
    g.applyPreset(preset("follow-the-money"));
    g.addGroup(group);
  });
  assert.deepEqual(view.focus.entities.map((e) => e.id), [OFFICIAL.id, group.id]);
  assert.equal(view.meta?.presetId, "follow-the-money");
});

test("FIX-1435: no setView call in useGraphView.ts reads the render's `view`", () => {
  // Each `setView(` argument, by balanced parens. An argument that names
  // `view` was computed from the render's closure and overwrites any update
  // queued before it in the same commit. restoreSavedView replaces by design
  // and passes `saved`, not `view`.
  const args: string[] = [];
  for (let at = HOOK_SRC.indexOf("setView("); at !== -1; at = HOOK_SRC.indexOf("setView(", at + 1)) {
    let depth = 0;
    let end = at + "setView".length;
    do {
      const ch = HOOK_SRC[end];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      end++;
    } while (depth > 0 && end < HOOK_SRC.length);
    args.push(HOOK_SRC.slice(at + "setView(".length, end - 1));
  }
  assert.ok(args.length >= 20, `found ${args.length} setView calls — the scan is reading the hook`);
  const offenders = args.filter((a) => /\bview\b/.test(a));
  assert.deepEqual(offenders, []);
});
