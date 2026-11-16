/**
 * FIX-1415 — docs/PHASE_GOALS.md → /api/phases → the /dashboard Development
 * Progress card. The percentages are computed from the checkboxes; the header
 * tokens are the document's claim, pinned here to within 1 point of the ratio.
 *
 * Counts over the real file are asserted against an independent line scan of
 * the same file, not literals: the roadmap changes and the test should not.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePhaseGoals, phasesPayload, itemLabel, PHASE_HEADER_RE } from "./phase-goals";
import { countPhaseBullets, parsePhaseHeaders, PHASE_HEADER_RE as SCRIPTS_RE } from "../../../../scripts/lib/phase-goals.mjs";

const REPO = join(__dirname, "..", "..", "..", "..");
const MD = readFileSync(join(REPO, "docs", "PHASE_GOALS.md"), "utf8");
const LINES = MD.replace(/\r\n/g, "\n").split("\n");

/** Each `## Phase N` section's lines, by a scan that shares no code with the parser. */
function sections(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of LINES) {
    const h = /^## (Phase \d+) /.exec(line);
    if (h) {
      cur = [];
      out.set(h[1]!, cur);
    } else if (line.startsWith("## ")) {
      cur = null;
    } else if (cur) {
      cur.push(line);
    }
  }
  return out;
}

describe("parsePhaseGoals — the real docs/PHASE_GOALS.md", () => {
  const phases = parsePhaseGoals(MD);
  const secs = sections();

  it("finds every `## Phase N` header", () => {
    assert.deepEqual(phases.map((p) => p.name), [...secs.keys()]);
    assert.ok(phases.length >= 6, `${phases.length} phases`);
  });

  it("checked + open + parked is each phase's top-level checkbox bullets", () => {
    for (const p of phases) {
      const bullets = secs.get(p.name)!.filter((l) => /^- \[[ xX]\] /.test(l));
      assert.equal(p.checked + p.open.length + p.parked, bullets.length, p.name);
      assert.equal(p.total, p.checked + p.open.length, p.name);
      assert.equal(p.pct, p.total === 0 ? 0 : Math.round((100 * p.checked) / p.total), p.name);
      assert.equal(p.done, p.pct === 100, p.name);
    }
  });

  it("Phase 1's parked lines are exactly its top-level bullets carrying `was FIX-`", () => {
    const p1 = phases.find((p) => p.name === "Phase 1")!;
    const parked = secs.get("Phase 1")!.filter((l) => /^- \[[ xX]\] /.test(l) && l.includes("was FIX-"));
    assert.equal(p1.parked, parked.length);
    assert.ok(p1.parked > 0, "Phase 1 has parked lines today; this assertion is not vacuous");
  });

  // D3 — the header token is the document's claim; the ratio is the number.
  it("each header token agrees with its checkbox ratio", () => {
    for (const p of phases) {
      const why = `${p.name} \`${p.token}\` vs ${p.checked}/${p.total} = ${p.pct}%`;
      if (p.headerPct === null) {
        assert.equal(p.token, "Planned", why);
        assert.equal(p.checked, 0, `${why} — \`Planned\` means nothing checked`);
      } else {
        assert.ok(Math.abs(p.headerPct - p.pct) <= 1, `${why} — the token is more than 1 point off`);
      }
      if (p.headerDone) assert.equal(p.pct, 100, `${why} — a \`✓\` header means 100`);
    }
  });

  it("agrees with the board's twin counter (scripts/lib/phase-goals.mjs)", () => {
    assert.equal(SCRIPTS_RE.source, PHASE_HEADER_RE.source);
    assert.equal(SCRIPTS_RE.flags, PHASE_HEADER_RE.flags);
    assert.deepEqual(
      countPhaseBullets(MD).map((c) => [c.name, c.checked, c.open, c.parked, c.pct]),
      phases.map((p) => [p.name, p.checked, p.open.length, p.parked, p.pct]),
    );
    assert.deepEqual(
      parsePhaseHeaders(MD).map((h) => [h.name, h.label]),
      phases.map((p) => [p.name, p.label]),
    );
  });
});

describe("phasesPayload — /api/phases' body", () => {
  it("current is the first phase under 100 on the real file, with its open items", () => {
    const body = phasesPayload(MD);
    const phases = parsePhaseGoals(MD);
    const first = phases.find((p) => p.pct < 100) ?? phases[phases.length - 1]!;
    assert.equal(body.current.name, first.name);
    assert.equal(body.current.checked, first.checked);
    assert.equal(body.current.total, first.total);
    assert.equal(body.current.parked, first.parked);
    assert.deepEqual(body.current.open, first.open);
    assert.deepEqual(Object.keys(body.phases[0]!).sort(), ["checked", "done", "label", "name", "pct", "total"]);
    assert.ok(!("fallback" in body));
  });

  it("current is the last phase when every phase is at 100", () => {
    const md = ["## Phase 0 — A ✓ `W` `100% complete`", "- [x] a", "## Phase 1 — B `W` `100% complete`", "- [x] b"].join("\n");
    assert.equal(phasesPayload(md).current.name, "Phase 1");
  });

  it("throws on a file with no phase header (the route answers `{ phases: [] }`)", () => {
    assert.throws(() => phasesPayload("# nothing here\n- [x] a"), /No phases found/);
  });
});

describe("parsePhaseGoals — fixture", () => {
  const FIXTURE = [
    "# Title",
    "## Phase 0 — Scaffold ✓ `Weeks 1–2` `100% complete`",
    "### Infrastructure",
    "- [x] one",
    "  - [ ] an indented sub-bullet does not count",
    "- [X] two",
    "## Phase 1 — MVP `Weeks 3–10` `~50% complete` ← **current**",
    "### Core",
    "- [x] done",
    "- [ ] Custom storage domain — still the R2-issued `pub-*.r2.dev` subdomain",
    "- [ ] Trending tabs on `/proposals` — was FIX-029; re-open when proposals carry comments",
    "- a plain bullet does not count",
    "### Remaining",
    "- [ ] **NYC Legistar pipeline** — blocked: requires API token",
    "## Not a phase",
    "- [x] outside every phase",
    "## Phase 2 — Growth `Weeks 11–22` `Planned`",
    "- [ ] Promise tracker live",
    "## Phase 3 — Social App `Weeks 23–34` `Planned`",
  ].join("\r\n");
  const phases = parsePhaseGoals(FIXTURE);
  const byName = (n: string) => phases.find((p) => p.name === n)!;

  it("reads CRLF, skips sub-bullets and plain bullets, and accepts `[X]`", () => {
    assert.deepEqual(phases.map((p) => p.name), ["Phase 0", "Phase 1", "Phase 2", "Phase 3"]);
    const p0 = byName("Phase 0");
    assert.equal(p0.checked, 2);
    assert.equal(p0.open.length, 0);
    assert.equal(p0.pct, 100);
    assert.equal(p0.done, true);
    assert.equal(p0.headerDone, true);
    assert.equal(p0.token, "100%");
  });

  it("a parked line is in neither count; open items carry their `### ` group", () => {
    const p1 = byName("Phase 1");
    assert.equal(p1.checked, 1);
    assert.equal(p1.parked, 1);
    assert.equal(p1.total, 3);
    assert.equal(p1.pct, 33);
    assert.equal(p1.headerPct, 50);
    assert.deepEqual(p1.open, [
      { label: "Custom storage domain", group: "Core" },
      { label: "NYC Legistar pipeline", group: "Remaining" },
    ]);
  });

  it("a non-phase `## ` ends the phase above it", () => {
    assert.equal(byName("Phase 1").checked, 1);
  });

  it("a `Planned` phase is 0, and a phase with no bullets is 0, not NaN", () => {
    const p2 = byName("Phase 2");
    assert.equal(p2.token, "Planned");
    assert.equal(p2.headerPct, null);
    assert.deepEqual([p2.checked, p2.total, p2.pct], [0, 1, 0]);
    assert.deepEqual(p2.open, [{ label: "Promise tracker live", group: null }]);
    const p3 = byName("Phase 3");
    assert.deepEqual([p3.checked, p3.total, p3.pct, p3.done], [0, 0, 0, false]);
  });
});

describe("itemLabel — D6's label rule", () => {
  /** A real bullet's text (after `- [ ] `), found by its opening words. */
  const real = (prefix: string): string => {
    const line = LINES.find((l) => /^- \[[ xX]\] /.test(l) && l.slice(6).startsWith(prefix));
    assert.ok(line, `no bullet in PHASE_GOALS.md starts with ${JSON.stringify(prefix)}`);
    return line.slice(6);
  };

  it("on three real bullets: cut at the first ` — `, drop backticks and bold markers", () => {
    assert.equal(itemLabel(real("Custom storage domain — ")), "Custom storage domain");
    assert.equal(itemLabel(real("**NYC Legistar pipeline** — ")), "NYC Legistar pipeline");
    assert.equal(
      itemLabel(real("Congress.gov API → officials + votes (`")),
      "Congress.gov API → officials + votes (packages/data/src/pipelines/congress/)",
    );
  });

  it("link syntax keeps its text", () => {
    assert.equal(itemLabel("See [the plan](docs/GRAPH_PLAN.md) for `x` — later"), "See the plan for x");
  });

  it("caps at 100 characters", () => {
    const out = itemLabel("a".repeat(150));
    assert.equal(out.length, 100);
    assert.ok(out.endsWith("…"));
    assert.equal(itemLabel("b".repeat(100)), "b".repeat(100));
  });
});
